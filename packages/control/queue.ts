import { cacheTag, needsFor } from "../shared/types.ts";
import { broadcast, broadcastWorkers, cancelOnWorker, workerView, workers } from "./hub.ts";
import type { Worker } from "./hub.ts";
import { jobRuns, newId, save, state } from "./store.ts";
import type { Job, Run } from "./store.ts";
import { updateRun, verifyRun } from "./verifier.ts";

const priority = { cli: 0, try: 1, webhook: 2 } as const;

export function jobView(job: Job) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    repo: job.repo,
    branch: job.branch,
    agent: job.agent,
    message: job.message,
    source: job.source,
    targets: job.targets,
    status: job.status,
    verdict: job.verdict,
    summary: job.summary,
    supersededBy: job.supersededBy,
    tryChange: job.tryChange,
    commit: job.commit,
    dirty: job.dirty,
    runs: jobRuns(job).map((run) => ({
      id: run.id,
      target: run.target,
      status: run.status,
      verdict: run.verdict,
      summary: run.summary,
      worker: run.worker,
      cold: run.cold,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      thumb: run.attempts.at(-1)?.result.steps.at(-2)?.file ?? run.attempts.at(-1)?.result.steps.at(-1)?.file ?? run.inspectShot,
      position: run.status === "queued" ? queuePosition(run) : undefined,
    })),
  };
}

function ordered() {
  return Object.values(state.runs)
    .filter((run) => run.status === "queued")
    .sort((a, b) => {
      const jobA = state.jobs[a.jobId];
      const jobB = state.jobs[b.jobId];
      return (
        priority[jobA.source] - priority[jobB.source] ||
        Number(a.target !== "web") - Number(b.target !== "web") ||
        a.createdAt - b.createdAt
      );
    });
}

export function queuePosition(run: Run) {
  return ordered().findIndex((item) => item.id === run.id) + 1;
}

export function averageSeconds() {
  const done = Object.values(state.runs)
    .filter((run) => run.status === "done" && run.startedAt && run.finishedAt)
    .slice(-10);
  if (!done.length) return 60;
  return done.reduce((sum, run) => sum + (run.finishedAt! - run.startedAt!) / 1000, 0) / done.length;
}

function blockedByStage(run: Run) {
  if (run.target === "web") return false;
  const job = state.jobs[run.jobId];
  const web = jobRuns(job).find((item) => item.target === "web");
  if (!web) return false;
  if (web.status === "done" && web.verdict === "pass") return false;
  if (web.status === "done" || web.status === "cancelled" || web.status === "skipped") {
    updateRun(run, { status: "skipped", summary: "Skipped: the cheaper web check did not pass, so no emulator time was spent", finishedAt: Date.now() });
    settleJob(job);
  }
  return true;
}

function freeOn(worker: Worker) {
  const view = workerView(worker);
  return { cpus: view.cpus - view.usedCpus, memoryMb: view.memoryMb - view.usedMemoryMb };
}

function pickWorker(run: Run, job: Job) {
  const needs = needsFor(run.target);
  const tag = cacheTag(job.repo, job.lockHash);
  const fitting = [...workers.values()].filter((worker) => {
    const free = freeOn(worker);
    return free.cpus >= needs.cpus && free.memoryMb >= needs.memoryMb && (!needs.kvm || (worker.info.kvm && worker.info.android));
  });
  fitting.sort((a, b) => {
    const warmA = a.info.images.includes(tag) ? 1 : 0;
    const warmB = b.info.images.includes(tag) ? 1 : 0;
    return warmB - warmA || freeOn(b).memoryMb - freeOn(a).memoryMb;
  });
  return fitting[0];
}

export function schedule() {
  for (const run of ordered()) {
    if (blockedByStage(run)) continue;
    const job = state.jobs[run.jobId];
    const worker = pickWorker(run, job);
    if (!worker) continue;
    worker.active.add(run.id);
    if (job.status === "queued") {
      job.status = "running";
      broadcast({ type: "job", job: jobView(job) });
    }
    broadcastWorkers();
    verifyRun(run, job, worker).finally(() => {
      worker.active.delete(run.id);
      broadcastWorkers();
      settleJob(job);
      schedule();
    });
  }
}

export function settleJob(job: Job) {
  const runs = jobRuns(job);
  if (job.status === "cancelled") return;
  if (!runs.every((run) => ["done", "cancelled", "skipped"].includes(run.status))) {
    broadcast({ type: "job", job: jobView(job) });
    return;
  }
  const judged = runs.filter((run) => run.status === "done");
  const verdict = judged.some((run) => run.verdict === "fail")
    ? "fail"
    : judged.some((run) => run.verdict === "unverified") || judged.length === 0
      ? "unverified"
      : "pass";
  const lead = judged.find((run) => run.verdict === verdict) ?? judged[0];
  Object.assign(job, { status: "done", verdict, summary: lead?.summary ?? "Nothing ran", finishedAt: Date.now() });
  broadcast({ type: "job", job: jobView(job) });
  save();
}

export function createJob(input: Omit<Job, "id" | "createdAt" | "status" | "runIds">) {
  const job: Job = { ...input, id: newId(), createdAt: Date.now(), status: "uploading", runIds: [] };
  state.jobs[job.id] = job;
  save();
  return job;
}

export function enqueue(job: Job) {
  for (const older of Object.values(state.jobs)) {
    if (older.id !== job.id && older.supersedeKey === job.supersedeKey && (older.status === "queued" || older.status === "running")) {
      cancelJob(older, `Replaced by a newer verify from the same agent and branch`);
      older.supersededBy = job.id;
    }
  }
  for (const target of job.targets) {
    const run: Run = {
      id: newId(),
      jobId: job.id,
      target,
      status: "queued",
      createdAt: Date.now(),
      events: [],
      net: [],
      memory: [],
      attempts: [],
    };
    state.runs[run.id] = run;
    job.runIds.push(run.id);
  }
  job.status = "queued";
  save();
  broadcast({ type: "job", job: jobView(job) });
  schedule();
}

export function cancelJob(job: Job, reason: string) {
  job.status = "cancelled";
  job.summary = reason;
  job.finishedAt = Date.now();
  for (const run of jobRuns(job)) {
    if (["done", "cancelled", "skipped"].includes(run.status)) continue;
    const wasRunning = run.status !== "queued";
    updateRun(run, { status: "cancelled", summary: reason, finishedAt: Date.now() });
    if (wasRunning) {
      for (const worker of workers.values()) {
        if (worker.active.has(run.id)) cancelOnWorker(worker, run.id);
      }
    }
  }
  broadcast({ type: "job", job: jobView(job) });
  save();
}

setInterval(schedule, 2000);
