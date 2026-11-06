import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { addClient, registerWorker, workerView, workers } from "./hub.ts";
import { averageSeconds, cancelJob, createJob, enqueue, jobView, queuePosition } from "./queue.ts";
import { buildTrySource, changes } from "./demo.ts";
import { dataDir, jobRuns, state } from "./store.ts";
import { offline, textModel, visionModel } from "./llm.ts";
import { autoscaleView } from "./autoscale.ts";

const port = Number(process.env.PORT ?? 7300);
const userTokens = new Set((process.env.VERIFY_TOKENS ?? "dev-token").split(",").map((token) => token.trim()).filter(Boolean));
const workerToken = process.env.WORKER_TOKEN ?? "dev-worker-token";
const webDir = path.resolve(import.meta.dirname, "../web/dist");
const tryLimitPerHour = Number(process.env.TRY_LIMIT_PER_HOUR ?? 40);

function bearer(request: http.IncomingMessage) {
  return String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
}

function json(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function clientIp(request: http.IncomingMessage) {
  return String(request.headers["x-forwarded-for"] ?? request.socket.remoteAddress ?? "").split(",")[0].trim();
}

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".apk": "application/vnd.android.package-archive",
};

function sendFile(request: http.IncomingMessage, response: http.ServerResponse, file: string, cache = "no-cache") {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(response, 404, { error: "not found" });
  const size = fs.statSync(file).size;
  const type = types[path.extname(file)] ?? "application/octet-stream";
  const range = request.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    response.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", "cache-control": cache });
  fs.createReadStream(file).pipe(response);
}

function overview() {
  const jobs = Object.values(state.jobs)
    .filter((job) => job.status !== "uploading")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 40)
    .map(jobView);
  const queued = Object.values(state.runs)
    .filter((run) => run.status === "queued")
    .sort((a, b) => queuePosition(a) - queuePosition(b))
    .map((run) => ({ id: run.id, jobId: run.jobId, target: run.target, createdAt: run.createdAt, message: state.jobs[run.jobId]?.message, agent: state.jobs[run.jobId]?.agent }));
  return {
    workers: [...workers.values()].map(workerView),
    jobs,
    queued,
    averageSeconds: averageSeconds(),
    models: { text: textModel, vision: visionModel, offline },
    autoscale: autoscaleView(),
    changes,
  };
}

function runDetail(id: string) {
  const run = state.runs[id];
  if (!run) return null;
  const job = state.jobs[run.jobId];
  return { ...run, job: { ...jobView(job), diff: job.diff, recipe: job.recipe } };
}

const recentTries: number[] = [];

async function route(request: http.IncomingMessage, response: http.ServerResponse) {
  const url = new URL(request.url ?? "/", "http://local");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method ?? "GET";

  if (parts[0] !== "api") {
    const file = path.join(webDir, url.pathname === "/" ? "index.html" : url.pathname);
    if (file.startsWith(webDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return sendFile(request, response, file, url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    }
    return sendFile(request, response, path.join(webDir, "index.html"));
  }

  if (method === "GET" && url.pathname === "/api/state") return json(response, 200, overview());

  if (method === "GET" && url.pathname === "/api/stream") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    response.write(": hello\n\n");
    addClient(response);
    return;
  }

  if (method === "GET" && parts[1] === "jobs" && parts[2] && !parts[3]) {
    const job = state.jobs[parts[2]];
    if (!job) return json(response, 404, { error: "no such job" });
    const view = jobView(job);
    return json(response, 200, {
      ...view,
      averageSeconds: averageSeconds(),
      workers: workers.size,
      runs: jobRuns(job).map((run) => ({
        ...view.runs.find((item) => item.id === run.id),
        events: run.events.slice(-60),
        bugs: run.bugs,
        checks: run.scenario?.checks,
        title: run.scenario?.title,
      })),
    });
  }

  if (method === "GET" && parts[1] === "runs" && parts[2]) {
    const detail = runDetail(parts[2]);
    return detail ? json(response, 200, detail) : json(response, 404, { error: "no such run" });
  }

  if (parts[1] === "artifacts" && parts[2] && parts[3]) {
    const dir = path.join(dataDir, "artifacts", parts[2].replace(/[^a-z0-9]/gi, ""));
    const file = path.join(dir, decodeURIComponent(parts[3]).replace(/[\/\\]/g, ""));
    if (method === "GET") return sendFile(request, response, file, "public, max-age=86400");
    if (method === "PUT") {
      if (bearer(request) !== workerToken) return json(response, 401, { error: "worker token required" });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, await readBody(request));
      return json(response, 200, { ok: true });
    }
  }

  if (method === "GET" && parts[1] === "files" && parts[2]) {
    return sendFile(request, response, path.join(dataDir, "files", parts[2].replace(/[^a-z0-9._-]/gi, "")), "public, max-age=3600");
  }

  if (method === "GET" && parts[1] === "sources" && parts[2]) {
    if (bearer(request) !== workerToken) return json(response, 401, { error: "worker token required" });
    return sendFile(request, response, path.join(dataDir, "sources", `${parts[2].replace(/[^a-z0-9]/gi, "")}.tgz`));
  }

  if (method === "POST" && url.pathname === "/api/jobs") {
    if (!userTokens.has(bearer(request))) return json(response, 401, { error: "Unknown token. Set VERIFY_TOKEN or run verify login." });
    const body = JSON.parse((await readBody(request)).toString() || "{}");
    const targets = (body.targets?.length ? body.targets : body.recipe?.platforms ?? ["web"]).map(String);
    const job = createJob({
      repo: String(body.repo ?? "repo"),
      branch: String(body.branch ?? "main"),
      agent: String(body.agent ?? "agent"),
      message: String(body.message ?? "").slice(0, 2000),
      source: body.source === "webhook" ? "webhook" : "cli",
      targets,
      lockHash: String(body.lockHash ?? "nolock"),
      recipe: body.recipe,
      diff: String(body.diff ?? "").slice(0, 200_000),
      supersedeKey: `${body.repo}|${body.branch}|${body.host ?? ""}`,
      commit: body.commit ? String(body.commit).slice(0, 40) : undefined,
      dirty: Number(body.dirty ?? 0) || 0,
    });
    return json(response, 200, { id: job.id, upload: `/api/jobs/${job.id}/source` });
  }

  if (method === "PUT" && parts[1] === "jobs" && parts[3] === "source") {
    if (!userTokens.has(bearer(request))) return json(response, 401, { error: "Unknown token" });
    const job = state.jobs[parts[2]];
    if (!job || job.status !== "uploading") return json(response, 404, { error: "no such job waiting for source" });
    fs.writeFileSync(path.join(dataDir, "sources", `${job.id}.tgz`), await readBody(request));
    enqueue(job);
    return json(response, 200, { id: job.id });
  }

  if (method === "POST" && parts[1] === "jobs" && parts[3] === "cancel") {
    if (!userTokens.has(bearer(request))) return json(response, 401, { error: "Unknown token" });
    const job = state.jobs[parts[2]];
    if (job) cancelJob(job, "Cancelled by the user");
    return json(response, 200, { ok: true });
  }

  if (method === "POST" && parts[1] === "try" && parts[2]) {
    const change = changes.find((item) => item.id === parts[2]);
    if (!change) return json(response, 404, { error: "no such change" });
    const ip = clientIp(request);
    const now = Date.now();
    while (recentTries.length && recentTries[0] < now - 3600_000) recentTries.shift();
    if (recentTries.length >= tryLimitPerHour) return json(response, 429, { error: "The demo is busy. Try again in a few minutes." });
    const mine = Object.values(state.jobs).find((job) => job.source === "try" && job.ip === ip && (job.status === "queued" || job.status === "running"));
    if (mine) return json(response, 200, { id: mine.id, existing: true });
    recentTries.push(now);
    const job = createJob({
      repo: "packing-list",
      branch: `try/${change.id}`,
      agent: "demo",
      message: change.message,
      source: "try",
      targets: url.searchParams.get("android") === "1" ? ["web", "android-34"] : ["web"],
      lockHash: "",
      recipe: { install: "", start: "", ready: "", platforms: ["web"] },
      diff: "",
      supersedeKey: `try|${ip}|${now}`,
      tryChange: change.id,
      ip,
    });
    Object.assign(job, buildTrySource(change, job.id));
    enqueue(job);
    return json(response, 200, { id: job.id });
  }

  return json(response, 404, { error: "not found" });
}

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error(error);
    if (!response.headersSent) json(response, 500, { error: String(error?.message ?? error) });
  });
});

const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://local");
  if (url.pathname !== "/worker" || url.searchParams.get("token") !== workerToken) {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (ws) => registerWorker(ws));
});

server.listen(port, process.env.HOST ?? "0.0.0.0", () => {
  console.log(`verify control on :${port} (${offline ? "offline model stand-in" : `models ${textModel} / ${visionModel}`})`);
});
