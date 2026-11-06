import fs from "node:fs";
import path from "node:path";
import type { EventLevel, ExecResult, MemorySample, NetEntry, Recipe } from "../shared/types.ts";

export const dataDir = path.resolve(process.env.VERIFY_DATA ?? "data");
fs.mkdirSync(path.join(dataDir, "sources"), { recursive: true });
fs.mkdirSync(path.join(dataDir, "artifacts"), { recursive: true });

export type Verdict = "pass" | "fail" | "unverified";

export type Job = {
  id: string;
  createdAt: number;
  finishedAt?: number;
  repo: string;
  branch: string;
  agent: string;
  message: string;
  source: "cli" | "try" | "webhook";
  targets: string[];
  lockHash: string;
  recipe: Recipe;
  diff: string;
  status: "uploading" | "queued" | "running" | "done" | "cancelled";
  verdict?: Verdict;
  summary?: string;
  runIds: string[];
  supersededBy?: string;
  supersedeKey: string;
  tryChange?: string;
  ip?: string;
  commit?: string;
  dirty?: number;
};

export type Check = { id: string; do: string; expect: string; result?: "pass" | "fail" | "unclear"; evidence?: string; step?: string };

export type Attempt = { n: number; script: string; result: ExecResult; oomKilled: boolean; fixedBecause?: string };

export type Run = {
  id: string;
  jobId: string;
  target: string;
  status: "queued" | "preparing" | "testing" | "judging" | "done" | "cancelled" | "skipped";
  verdict?: Verdict;
  summary?: string;
  bugs?: { title: string; repro: string[] }[];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  worker?: string;
  cold?: boolean;
  prepareSeconds?: number;
  events: { t: number; level: EventLevel; text: string }[];
  net: NetEntry[];
  memory: MemorySample[];
  memoryCapMb?: number;
  scenario?: { title: string; checks: Check[] };
  attempts: Attempt[];
  inspectShot?: string;
  liveShots?: { label: string; file: string }[];
  error?: string;
};

type State = { jobs: Record<string, Job>; runs: Record<string, Run> };

const file = path.join(dataDir, "state.json");
export const state: State = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { jobs: {}, runs: {} };

for (const run of Object.values(state.runs)) {
  if (!["done", "cancelled", "skipped"].includes(run.status)) {
    run.status = "cancelled";
    run.summary = "Control restarted while this run was in progress";
  }
}
for (const job of Object.values(state.jobs)) {
  if (job.status !== "done" && job.status !== "cancelled") job.status = "cancelled";
}

let timer: NodeJS.Timeout | null = null;
export function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
    fs.renameSync(`${file}.tmp`, file);
  }, 500);
}

export function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function jobRuns(job: Job) {
  return job.runIds.map((id) => state.runs[id]).filter(Boolean);
}
