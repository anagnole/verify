import { broadcastWorkers, workers } from "./hub.ts";
import { state } from "./store.ts";
import { createInstance, deleteInstance, listInstances, vultrKey } from "./vultr.ts";

const snapshotId = process.env.WORKER_SNAPSHOT_ID ?? "";
const plan = process.env.WORKER_PLAN ?? "vx1-g-4c-16g-240s";
const region = process.env.WORKER_REGION ?? "fra";
const maxWorkers = Number(process.env.MAX_WORKERS ?? 3);
const scaleAfterSeconds = Number(process.env.SCALE_AFTER_SECONDS ?? 40);
const idleSeconds = Number(process.env.IDLE_SECONDS ?? 300);
const controlUrl = process.env.PUBLIC_CONTROL_URL ?? "";
const workerToken = process.env.WORKER_TOKEN ?? "dev-worker-token";
const enabled = Boolean(vultrKey() && snapshotId && controlUrl);

const pending = new Map<string, { label: string; since: number; id?: string }>();
const idleSince = new Map<string, number>();
let counter = 0;
let retryAfter = 0;

export function autoscaleView() {
  return { enabled, max: maxWorkers, pending: [...pending.values()].map(({ label, since }) => ({ label, since })) };
}

function userData(label: string) {
  return `#!/bin/bash
cat > /etc/verify-worker.env <<EOF
CONTROL_URL=${controlUrl}
WORKER_TOKEN=${workerToken}
WORKER_NAME=${label}
WORKER_REGION=${region}
WORKER_AUTOSCALED=1
EOF
systemctl restart verify-worker
`;
}

function readyToStart(run: { jobId: string; target: string }) {
  if (run.target === "web") return true;
  const job = state.jobs[run.jobId];
  const web = job?.runIds.map((id) => state.runs[id]).find((item) => item?.target === "web");
  return !web || (web.status === "done" && web.verdict === "pass");
}

function oldestStuckRun() {
  const now = Date.now();
  return Object.values(state.runs).find(
    (run) => run.status === "queued" && readyToStart(run) && now - Math.max(run.createdAt, readySince(run)) > scaleAfterSeconds * 1000,
  );
}

function readySince(run: { jobId: string; target: string }) {
  if (run.target === "web") return 0;
  const job = state.jobs[run.jobId];
  const web = job?.runIds.map((id) => state.runs[id]).find((item) => item?.target === "web");
  return web?.finishedAt ?? 0;
}

async function tick() {
  for (const [label] of pending) {
    if ([...workers.values()].some((worker) => worker.info.name === label)) {
      pending.delete(label);
      broadcastWorkers();
    }
  }

  const stuck = oldestStuckRun();
  if (stuck && pending.size === 0 && workers.size + pending.size < maxWorkers && Date.now() > retryAfter) {
    counter += 1;
    const label = `verify-worker-auto-${Date.now().toString(36).slice(-4)}${counter}`;
    pending.set(label, { label, since: Date.now() });
    broadcastWorkers();
    console.log(`autoscale: queue waiting, creating ${label}`);
    try {
      const instance = await createInstance({ label, plan, region, snapshotId, userData: userData(label), tags: ["verify", "verify-auto"] });
      pending.get(label)!.id = instance.id;
    } catch (error: any) {
      console.error(`autoscale: create failed: ${error.message}`);
      pending.delete(label);
      retryAfter = Date.now() + 120_000;
    }
  }

  for (const worker of workers.values()) {
    if (!worker.info.autoscaled) continue;
    if (worker.active.size > 0) {
      idleSince.delete(worker.id);
      continue;
    }
    const since = idleSince.get(worker.id) ?? Date.now();
    idleSince.set(worker.id, since);
    if (Date.now() - since < idleSeconds * 1000) continue;
    const queued = Object.values(state.runs).some((run) => run.status === "queued");
    if (queued) continue;
    idleSince.delete(worker.id);
    console.log(`autoscale: ${worker.info.name} idle, destroying it`);
    try {
      const instance = (await listInstances("verify-auto")).find((item) => item.label === worker.info.name);
      worker.socket.close();
      if (instance) await deleteInstance(instance.id);
    } catch (error: any) {
      console.error(`autoscale: delete failed: ${error.message}`);
    }
  }
}

if (enabled) {
  console.log(`autoscale on: ${plan} in ${region}, up to ${maxWorkers} workers`);
  setInterval(() => tick().catch((error) => console.error(error)), 10000);
}
