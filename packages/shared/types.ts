export type Recipe = {
  install: string;
  start: string;
  ready: string;
  platforms: string[];
  allow?: string[];
  android_apk?: string;
  android_package?: string;
  android_start?: string;
};

export type Needs = { cpus: number; memoryMb: number; kvm?: boolean };

export type Step = { label: string; file: string; at: number };

export type ExecResult = {
  ok: boolean;
  scriptError: string | null;
  steps: Step[];
  consoleErrors: string[];
  failedRequests: { url: string; error?: string }[];
  heap: { t: number; mb: number }[];
  crashed: boolean;
  durationMs: number;
  aria?: string;
  elements?: string;
  video?: string;
};

export type NetEntry = { t: number; kind: string; host: string; action: "allowed" | "blocked"; phase?: string };

export type MemorySample = { t: number; mb: number };

export type PrepareRequest = {
  runId: string;
  repo: string;
  lockHash: string;
  recipe: Recipe;
  sourceUrl: string;
  target: string;
  needs: Needs;
};

export type RpcMethod = "prepare" | "inspect" | "exec" | "finish";

export type ToWorker =
  | { type: "call"; id: string; method: RpcMethod; params: any }
  | { type: "cancel"; runId: string };

export type WorkerInfo = {
  name: string;
  cpus: number;
  memoryMb: number;
  kvm: boolean;
  android?: boolean;
  images: string[];
  region?: string;
  autoscaled?: boolean;
};

export type FromWorker =
  | { type: "hello"; info: WorkerInfo }
  | { type: "reply"; id: string; ok: boolean; data?: any; error?: string }
  | { type: "event"; runId: string; level: EventLevel; text: string }
  | { type: "net"; runId: string; entry: NetEntry }
  | { type: "memory"; runId: string; sample: MemorySample }
  | { type: "images"; images: string[] }
  | { type: "shot"; runId: string; label: string; file: string };

export type EventLevel = "info" | "step" | "warn" | "error" | "block" | "ok";

export function cacheTag(repo: string, lockHash: string) {
  const slug = repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "repo";
  return `verify-cache/${slug}:${lockHash.slice(0, 16)}`;
}

export function needsFor(target: string): Needs {
  if (target.startsWith("android")) return { cpus: 2, memoryMb: 6144, kvm: true };
  return { cpus: 2, memoryMb: 3072 };
}
