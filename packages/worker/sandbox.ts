import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { docker, dockerOk, follow } from "./docker.ts";
import { cacheTag } from "../shared/types.ts";
import type { EventLevel, MemorySample, NetEntry, PrepareRequest } from "../shared/types.ts";

const BASE_IMAGE = process.env.VERIFY_BASE_IMAGE ?? "verify-base:latest";
const ANDROID_IMAGE = process.env.VERIFY_ANDROID_IMAGE ?? "verify-android:ready";
const REGISTRY_HOSTS = ["registry.npmjs.org", "registry.yarnpkg.com", "registry.npmmirror.com"];
const APP_DIR = "/app";
const ANDROID_PLATFORM_HOSTS = "googleapis.com,gstatic.com,google.com,android.com,googleusercontent.com,gvt1.com,gvt2.com,youtube.com,googlevideo.com,doubleclick.net,app-measurement.com,mobile.dev,android.clients.google.com";
const SANDBOX_DIR = path.resolve(import.meta.dirname, "../../sandbox");
const mounts = [
  "-v", `${SANDBOX_DIR}/runner.mjs:/opt/verify/runner.mjs:ro`,
  "-v", `${SANDBOX_DIR}/netguard.mjs:/opt/verify/netguard.mjs:ro`,
  "-v", `${SANDBOX_DIR}/android-runner.mjs:/opt/verify/android-runner.mjs:ro`,
];

export type Hooks = {
  event: (runId: string, level: EventLevel, text: string) => void;
  net: (runId: string, entry: NetEntry) => void;
  memory: (runId: string, sample: MemorySample) => void;
  upload: (runId: string, name: string, file: string) => Promise<void>;
  download: (url: string, file: string) => Promise<void>;
  imagesChanged: () => void;
  shot: (runId: string, label: string, file: string) => void;
};

type Run = {
  id: string;
  name: string;
  network: string;
  netguard: string;
  proxy: string;
  dir: string;
  phase: string;
  ready: string;
  android: boolean;
  appId: string;
  stops: (() => void)[];
  startedAt: number;
  installBlocked: string[];
};

const runs = new Map<string, Run>();

export async function listCacheImages() {
  const out = await docker(["images", "--format", "{{.Repository}}:{{.Tag}}", "verify-cache/*"]);
  return out.stdout.split("\n").filter(Boolean);
}

async function imageExists(tag: string) {
  return (await docker(["image", "inspect", tag])).code === 0;
}

async function newestImageFor(repoTag: string) {
  const repo = repoTag.split(":")[0];
  const out = await docker(["images", "--format", "{{.Repository}}:{{.Tag}}", repo]);
  return out.stdout.split("\n").filter(Boolean)[0];
}

function tarArgs(source: string) {
  if (process.platform === "darwin") return ["--uid", "0", "--gid", "0", "--no-xattrs", "--no-mac-metadata", "-C", source, "-cf", "-", "."];
  return ["--owner=0", "--group=0", "--numeric-owner", "-C", source, "-cf", "-", "."];
}

async function copyInto(container: string, source: string) {
  const tar = spawn("tar", tarArgs(source), { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const result = await docker(["cp", "-", `${container}:${APP_DIR}`], { input: tar.stdout });
  if (result.code !== 0) throw new Error(`copy failed: ${result.stderr}`);
}

async function exec(container: string, command: string, options: { onLine?: (line: string) => void; timeoutMs?: number } = {}) {
  return docker(["exec", container, "sh", "-c", command], options);
}

function parseMem(text: string) {
  const match = text.match(/([\d.]+)\s*([KMG]i?B)/);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2][0];
  return Math.round(unit === "G" ? value * 1024 : unit === "K" ? value / 1024 : value);
}

export async function prepare(request: PrepareRequest, hooks: Hooks) {
  const started = Date.now();
  const short = request.runId.slice(0, 8);
  const run: Run = {
    id: request.runId,
    name: `verify-sb-${short}`,
    network: `verify-net-${short}`,
    netguard: `verify-ng-${short}`,
    proxy: "",
    dir: await fs.mkdtemp(path.join(os.tmpdir(), `verify-${short}-`)),
    phase: "setup",
    ready: request.recipe.ready,
    android: request.target.startsWith("android"),
    appId: request.recipe.android_package ?? "",
    stops: [],
    startedAt: started,
    installBlocked: [],
  };
  runs.set(run.id, run);
  const say = (level: EventLevel, text: string) => hooks.event(run.id, level, text);

  const archive = path.join(run.dir, "source.tgz");
  const source = path.join(run.dir, "src");
  await hooks.download(request.sourceUrl, archive);
  await fs.mkdir(source);
  await new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", ["-xzf", archive, "-C", source]);
    tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error("could not unpack source"))));
  });

  await dockerOk(["network", "create", "--internal", run.network]);
  const allowInstall = [...REGISTRY_HOSTS, ...(request.recipe.allow ?? [])].join(",");
  const quietHosts = run.android ? ["-e", `QUIET=${ANDROID_PLATFORM_HOSTS}`] : [];
  await dockerOk(["run", "-d", "--name", run.netguard, "--network", "bridge", ...mounts, ...quietHosts, "-e", `ALLOW=${allowInstall}`, BASE_IMAGE, "node", "/opt/verify/netguard.mjs"]);
  await dockerOk(["network", "connect", run.network, run.netguard]);
  const ip = await dockerOk(["inspect", "-f", `{{(index .NetworkSettings.Networks "${run.network}").IPAddress}}`, run.netguard]);
  run.proxy = `http://${ip}:3128`;
  run.stops.push(
    follow(["logs", "-f", run.netguard], (line) => {
      try {
        const entry = JSON.parse(line);
        if (entry.kind === "ready") return;
        const net: NetEntry = { ...entry, phase: run.phase };
        hooks.net(run.id, net);
        if (run.phase === "install" && net.action === "blocked") run.installBlocked.push(`${net.kind}:${net.host}`);
        if (net.action === "blocked") say("block", `Blocked ${net.kind === "dns" ? "lookup of" : "connection to"} ${net.host} during ${run.phase}`);
      } catch {}
    }),
  );
  say("info", `Network locked: only ${REGISTRY_HOSTS[0]} during install${request.recipe.allow?.length ? `, plus ${request.recipe.allow.join(", ")}` : ""}`);

  const tag = cacheTag(run.android ? `${request.repo}-android` : request.repo, request.lockHash);
  const warm = await imageExists(tag);
  const cachedBlocked = warm ? (await docker(["image", "inspect", "-f", '{{index .Config.Labels "verify.blocked"}}', tag])).stdout.trim() : "";
  const from = warm ? tag : (await newestImageFor(tag)) ?? (run.android ? ANDROID_IMAGE : BASE_IMAGE);
  say("info", warm ? "Warm start: saved image for this repo and lockfile" : "Cold start: installing dependencies once for this lockfile");

  const limits = [
    "--cpus", String(request.needs.cpus),
    "--memory", `${request.needs.memoryMb}m`,
    "--memory-swap", `${request.needs.memoryMb}m`,
    "--pids-limit", "4096",
    "--shm-size", "1g",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--init",
    ...(run.android ? ["--device", "/dev/kvm"] : []),
  ];
  await dockerOk([
    "run", "-d", "--name", run.name,
    "--network", run.network,
    "--dns", ip,
    ...limits,
    ...mounts,
    "-e", `HTTP_PROXY=${run.proxy}`,
    "-e", `HTTPS_PROXY=${run.proxy}`,
    "-e", `VERIFY_PROXY=${run.proxy}`,
    "-e", "NO_PROXY=localhost,127.0.0.1",
    from,
  ]);
  say("info", `Sandbox up: ${request.needs.cpus} CPUs, ${request.needs.memoryMb} MB memory cap, no secrets, all capabilities dropped`);

  for (const item of cachedBlocked.split(" ").filter((value) => value.includes(":"))) {
    const [kind, host] = item.split(":");
    hooks.net(run.id, { t: Date.now(), kind, host, action: "blocked", phase: "install" });
    say("block", `Blocked ${kind === "dns" ? "lookup of" : "connection to"} ${host} when this lockfile was installed (warm start reuses that install)`);
  }

  await exec(run.name, `mkdir -p /work && find ${APP_DIR} -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +`);
  await copyInto(run.name, source);

  if (!warm) {
    run.phase = "install";
    say("step", `Installing: ${request.recipe.install}`);
    let shown = 0;
    const installStarted = Date.now();
    const install = await exec(run.name, `cd ${APP_DIR} && ${request.recipe.install} 2>&1`, {
      timeoutMs: 15 * 60_000,
      onLine: (line) => {
        const text = line.trim();
        if (!text || /^npm (warn|notice)|^(\d+ packages are looking|run `npm fund`|To address|Run `npm audit`|found 0 vulnerabilities)/i.test(text)) return;
        if (/vulnerabilit/i.test(text)) return;
        if (shown++ < 6) say("info", text.slice(0, 300));
      },
    });
    if (install.code !== 0) {
      say("error", `Install failed (exit ${install.code})`);
      return { ok: false, error: `Install failed:\n${install.stdout.slice(-3000)}`, cold: true, seconds: (Date.now() - started) / 1000 };
    }
    say("info", `Dependencies installed in ${Math.round((Date.now() - installStarted) / 1000)} s`);
    await dockerOk(["commit", "--change", `LABEL verify.blocked="${[...new Set(run.installBlocked)].join(" ")}"`, run.name, tag]);
    say("ok", "Saved this install as a warm image for the next runs");
    hooks.imagesChanged();
  }

  run.phase = "run";
  const allowRun = (request.recipe.allow ?? []).join(",");
  await exec(run.netguard, `printf '%s' '${allowRun}' > /tmp/allow`);
  say("info", allowRun ? `Network during the run: only ${allowRun}` : "Network during the run: nothing outside the sandbox");

  run.stops.push(
    follow(["stats", "--format", "{{.MemUsage}}", run.name], (line) => {
      const mb = parseMem(line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
      if (mb !== null) hooks.memory(run.id, { t: Date.now() - started, mb });
    }),
  );

  if (run.android) return prepareAndroid(run, request, hooks, started, !warm);

  say("step", `Starting the app: ${request.recipe.start}`);
  await docker(["exec", "-d", run.name, "sh", "-c", `cd ${APP_DIR} && ${request.recipe.start} > /tmp/app.log 2>&1`]);
  const readyBy = Date.now() + 240_000;
  while (Date.now() < readyBy) {
    const probe = await exec(run.name, `node -e "fetch('${request.recipe.ready}').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"`);
    if (probe.code === 0) {
      say("ok", `App is up at ${request.recipe.ready}`);
      return { ok: true, cold: !warm, seconds: (Date.now() - started) / 1000 };
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const log = await exec(run.name, "tail -n 60 /tmp/app.log");
  say("error", "The app did not come up within 4 minutes");
  return { ok: false, error: `App never became ready:\n${log.stdout}`, cold: !warm, seconds: (Date.now() - started) / 1000 };
}

async function prepareAndroid(run: Run, request: PrepareRequest, hooks: Hooks, started: number, cold: boolean) {
  const say = (level: EventLevel, text: string) => hooks.event(run.id, level, text);
  const fail = (error: string) => ({ ok: false, error, cold, seconds: (Date.now() - started) / 1000 });
  if (!request.recipe.android_apk || !run.appId) return fail("verify.yml needs android_apk and android_package for Android runs");
  say("step", "Booting the Android emulator from its saved state");
  await docker(["exec", "-d", run.name, "sh", "-c", "emulator -avd verify34 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -accel on -snapshot ready -no-snapshot-save > /tmp/emulator.log 2>&1"]);
  const apk = path.join(run.dir, "app.apk");
  await hooks.download(request.recipe.android_apk, apk);
  await dockerOk(["cp", apk, `${run.name}:/work/app.apk`]);
  const metro = request.recipe.android_start ?? "npx expo start --port 8081";
  say("step", `Starting Metro for the JS bundle: ${metro}`);
  await docker(["exec", "-d", run.name, "sh", "-c", `cd ${APP_DIR} && ${metro} > /tmp/app.log 2>&1`]);
  const bootBy = Date.now() + 240_000;
  let booted = false;
  while (Date.now() < bootBy) {
    const probe = await exec(run.name, "adb shell getprop sys.boot_completed 2>/dev/null");
    if (probe.stdout.trim() === "1") {
      booted = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!booted) {
    const log = await exec(run.name, "tail -n 30 /tmp/emulator.log");
    return fail(`The emulator did not boot:\n${log.stdout}`);
  }
  say("ok", `Emulator up (Android 14) after ${Math.round((Date.now() - started) / 1000)} s`);
  const install = await exec(run.name, "adb reverse tcp:8081 tcp:8081 && adb install -r -g /work/app.apk 2>&1");
  if (install.code !== 0) return fail(`Could not install the APK:\n${install.stdout.slice(-800)}`);
  say("ok", `Installed ${run.appId}`);
  const readyBy = Date.now() + 180_000;
  while (Date.now() < readyBy) {
    const probe = await exec(run.name, `node -e "fetch('http://localhost:8081/status').then(r=>r.text()).then(t=>process.exit(t.includes('running')?0:1)).catch(()=>process.exit(1))"`);
    if (probe.code === 0) {
      say("ok", "Metro is serving the app's JS");
      return { ok: true, cold, seconds: (Date.now() - started) / 1000 };
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const log = await exec(run.name, "tail -n 40 /tmp/app.log");
  return fail(`Metro never became ready:\n${log.stdout}`);
}

async function collect(run: Run, prefix: string, hooks: Hooks) {
  const out = path.join(run.dir, `${prefix}out`);
  await fs.rm(out, { recursive: true, force: true });
  await docker(["cp", `${run.name}:/work/out`, out]);
  const files = await fs.readdir(out, { withFileTypes: true }).catch(() => []);
  for (const entry of files) {
    if (entry.isFile()) await hooks.upload(run.id, `${prefix}${entry.name}`, path.join(out, entry.name));
  }
  const raw = await fs.readFile(path.join(out, "result.json"), "utf8").catch(() => null);
  return raw ? JSON.parse(raw) : null;
}

async function oomKills(container: string) {
  const events = await exec(container, "cat /sys/fs/cgroup/memory.events 2>/dev/null");
  const match = events.stdout.match(/oom_kill (\d+)/);
  return match ? Number(match[1]) : 0;
}

export async function inspect(runId: string, hooks: Hooks) {
  const run = mustGet(runId);
  hooks.event(runId, "step", "Opening the app to see what is on screen");
  const command = run.android
    ? `node /opt/verify/android-runner.mjs inspect ${run.appId} "" /work/out`
    : `node /opt/verify/runner.mjs inspect ${run.ready} "" /work/out`;
  await exec(run.name, command, { timeoutMs: 300_000 });
  const result = await collect(run, "inspect-", hooks);
  if (!result) return { ok: false, error: "Could not open the app" };
  return { ok: result.ok, aria: result.aria, elements: result.elements, screenshot: "inspect-inspect.png", error: result.scriptError };
}

export async function execScript(params: { runId: string; attempt: number; script: string }, hooks: Hooks) {
  const run = mustGet(params.runId);
  const file = path.join(run.dir, `script-${params.attempt}.${run.android ? "yaml" : "mjs"}`);
  await fs.writeFile(file, params.script);
  await dockerOk(["cp", file, `${run.name}:/work/${run.android ? "script.yaml" : "script.mjs"}`]);
  const before = await oomKills(run.name);
  hooks.event(run.id, "step", params.attempt === 1 ? "Running the test scenario" : `Running the fixed script (attempt ${params.attempt})`);
  const prefix = `a${params.attempt}-`;
  const live: Promise<void>[] = [];
  const runCommand = run.android
    ? `node /opt/verify/android-runner.mjs run ${run.appId} /work/script.yaml /work/out`
    : `node /opt/verify/runner.mjs run ${run.ready} /work/script.mjs /work/out`;
  const runResult = await exec(run.name, runCommand, {
    timeoutMs: 200_000,
    onLine: (line) => {
      try {
        const event = JSON.parse(line);
        if (event.event !== "step") return;
        hooks.event(run.id, "info", `Screenshot: ${event.label}`);
        const local = path.join(run.dir, `${prefix}${event.file}`);
        live.push(
          docker(["cp", `${run.name}:/work/out/${event.file}`, local])
            .then(() => hooks.upload(run.id, `${prefix}${event.file}`, local))
            .then(() => hooks.shot(run.id, event.label, `${prefix}${event.file}`))
            .catch(() => {}),
        );
      } catch {}
    },
  });
  await Promise.all(live);
  const after = await oomKills(run.name);
  const oomKilled = after > before;
  const result = (await collect(run, prefix, hooks)) ?? {
    ok: false,
    scriptError: oomKilled ? "The browser was killed by the sandbox memory cap" : `Runner exited with code ${runResult.code}`,
    steps: [],
    consoleErrors: [],
    failedRequests: [],
    heap: [],
    crashed: true,
    durationMs: 0,
  };
  if (oomKilled) hooks.event(run.id, "block", "Memory cap reached: the sandbox killed the runaway process");
  result.steps = (result.steps ?? []).map((step: any) => ({ ...step, file: `${prefix}${step.file}` }));
  if (result.video) result.video = `${prefix}${result.video}`;
  return { result, oomKilled };
}

export async function finish(runId: string, hooks: Hooks) {
  const run = runs.get(runId);
  if (!run) return { ok: true };
  runs.delete(runId);
  for (const stop of run.stops) stop();
  await docker(["rm", "-f", run.name, run.netguard]);
  await docker(["network", "rm", run.network]);
  await fs.rm(run.dir, { recursive: true, force: true });
  hooks.event(runId, "ok", "Sandbox destroyed: container, network and files removed");
  return { ok: true };
}

export function activeRuns() {
  return [...runs.keys()];
}

function mustGet(runId: string) {
  const run = runs.get(runId);
  if (!run) throw new Error(`No sandbox for run ${runId}`);
  return run;
}
