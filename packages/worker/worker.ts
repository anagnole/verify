import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { docker } from "./docker.ts";
import { activeRuns, execScript, finish, inspect, listCacheImages, prepare } from "./sandbox.ts";
import type { Hooks } from "./sandbox.ts";
import type { FromWorker, ToWorker, WorkerInfo } from "../shared/types.ts";

const control = (process.env.CONTROL_URL ?? "http://localhost:7300").replace(/\/$/, "");
const token = process.env.WORKER_TOKEN ?? "dev-worker-token";
const name = process.env.WORKER_NAME ?? "worker-local";
const auth = { authorization: `Bearer ${token}` };

let socket: WebSocket | null = null;

function send(message: FromWorker) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

const hooks: Hooks = {
  event: (runId, level, text) => send({ type: "event", runId, level, text }),
  net: (runId, entry) => send({ type: "net", runId, entry }),
  memory: (runId, sample) => send({ type: "memory", runId, sample }),
  upload: async (runId, file, local) => {
    const body = fs.readFileSync(local);
    await fetch(`${control}/api/artifacts/${runId}/${encodeURIComponent(file)}`, { method: "PUT", headers: auth, body });
  },
  download: async (url, file) => {
    const full = url.startsWith("http") ? url : `${control}${url}`;
    const response = await fetch(full, { headers: full.startsWith(control) ? auth : {} });
    if (!response.ok || !response.body) throw new Error(`download failed: ${response.status}`);
    await pipeline(Readable.fromWeb(response.body as any), fs.createWriteStream(file));
  },
  imagesChanged: async () => send({ type: "images", images: await listCacheImages() }),
  shot: (runId, label, file) => send({ type: "shot", runId, label, file }),
};

async function info(): Promise<WorkerInfo> {
  const raw = await docker(["info", "--format", "{{.NCPU}} {{.MemTotal}}"]);
  const [cpus, memBytes] = raw.stdout.trim().split(" ").map(Number);
  return {
    name,
    cpus: cpus || 2,
    memoryMb: Math.max(1024, Math.round((memBytes || 4e9) / 1048576) - 1024),
    kvm: fs.existsSync("/dev/kvm"),
    android: fs.existsSync("/dev/kvm") && (await docker(["image", "inspect", process.env.VERIFY_ANDROID_IMAGE ?? "verify-android:ready"])).code === 0,
    images: await listCacheImages(),
    region: process.env.WORKER_REGION,
    autoscaled: process.env.WORKER_AUTOSCALED === "1",
  };
}

async function handle(message: ToWorker) {
  if (message.type === "cancel") {
    await finish(message.runId, hooks).catch(() => {});
    return;
  }
  const { id, method, params } = message;
  try {
    let data: any;
    if (method === "prepare") data = await prepare(params, hooks);
    else if (method === "inspect") data = await inspect(params.runId, hooks);
    else if (method === "exec") data = await execScript(params, hooks);
    else if (method === "finish") data = await finish(params.runId, hooks);
    send({ type: "reply", id, ok: true, data });
  } catch (error: any) {
    send({ type: "reply", id, ok: false, error: String(error?.message ?? error) });
  }
}

function connect() {
  const url = `${control.replace(/^http/, "ws")}/worker?token=${encodeURIComponent(token)}`;
  socket = new WebSocket(url);
  socket.addEventListener("open", async () => {
    console.log(`connected to ${control} as ${name}`);
    send({ type: "hello", info: await info() });
  });
  socket.addEventListener("message", (event) => {
    handle(JSON.parse(String(event.data)));
  });
  socket.addEventListener("close", () => {
    console.log("disconnected, retrying in 3 s");
    for (const runId of activeRuns()) finish(runId, hooks).catch(() => {});
    setTimeout(connect, 3000);
  });
  socket.addEventListener("error", () => {});
}

connect();
