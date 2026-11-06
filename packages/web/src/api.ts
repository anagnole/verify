import { useEffect, useRef, useState } from "react";

export type Verdict = "pass" | "fail" | "unverified";

export type RunSummary = {
  id: string;
  target: string;
  status: string;
  verdict?: Verdict;
  summary?: string;
  worker?: string;
  cold?: boolean;
  startedAt?: number;
  finishedAt?: number;
  thumb?: string;
  position?: number;
};

export type JobView = {
  id: string;
  createdAt: number;
  finishedAt?: number;
  repo: string;
  branch: string;
  agent: string;
  message: string;
  source: string;
  targets: string[];
  status: string;
  verdict?: Verdict;
  summary?: string;
  supersededBy?: string;
  tryChange?: string;
  commit?: string;
  dirty?: number;
  runs: RunSummary[];
};

export type WorkerView = {
  id: string;
  name: string;
  region?: string;
  autoscaled?: boolean;
  kvm: boolean;
  android?: boolean;
  cpus: number;
  memoryMb: number;
  usedCpus: number;
  usedMemoryMb: number;
  images: number;
  active: string[];
  connectedAt: number;
};

export type Change = { id: string; title: string; message: string; blurb: string; expect: string };

export type Overview = {
  workers: WorkerView[];
  jobs: JobView[];
  queued: { id: string; jobId: string; target: string; createdAt: number; message: string; agent: string }[];
  averageSeconds: number;
  models: { text: string; vision: string; offline: boolean };
  autoscale: { enabled: boolean; max: number; pending: { label: string; since: number }[] };
  changes: Change[];
};

export type Event = { t: number; level: string; text: string };
export type NetEntry = { t: number; kind: string; host: string; action: string; phase?: string };
export type Step = { label: string; file: string; at: number };

export type RunDetail = {
  id: string;
  jobId: string;
  target: string;
  status: string;
  verdict?: Verdict;
  summary?: string;
  bugs?: { title: string; repro: string[] }[];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  worker?: string;
  cold?: boolean;
  prepareSeconds?: number;
  events: Event[];
  net: NetEntry[];
  memory: { t: number; mb: number }[];
  memoryCapMb?: number;
  scenario?: { title: string; checks: { id: string; do: string; expect: string; result?: string; evidence?: string; step?: string }[] };
  attempts: {
    n: number;
    script: string;
    oomKilled: boolean;
    fixedBecause?: string;
    result: { ok: boolean; scriptError: string | null; steps: Step[]; consoleErrors: string[]; heap: { t: number; mb: number }[]; crashed: boolean; video?: string };
  }[];
  inspectShot?: string;
  liveShots?: { label: string; file: string }[];
  job: JobView & { diff: string; recipe: { install: string; start: string; ready: string; allow?: string[] } };
};

export function artifactUrl(runId: string, file: string) {
  return `/api/artifacts/${runId}/${encodeURIComponent(file)}`;
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

type Listener = (message: any) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

function ensureStream() {
  if (source) return;
  source = new EventSource("/api/stream");
  source.onmessage = (event) => {
    const message = JSON.parse(event.data);
    for (const listener of listeners) listener(message);
  };
  source.onerror = () => {
    source?.close();
    source = null;
    setTimeout(ensureStream, 2000);
  };
}

export function useStream(listener: Listener) {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    ensureStream();
    const wrapped: Listener = (message) => ref.current(message);
    listeners.add(wrapped);
    return () => {
      listeners.delete(wrapped);
    };
  }, []);
}

export function useRefreshing<T>(load: () => Promise<T>, shouldRefresh: (message: any) => boolean, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const timer = useRef<number | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const refresh = () => {
    if (timer.current) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      loadRef.current().then(setData).catch(() => {});
    }, 250);
  };
  useEffect(() => {
    loadRef.current().then(setData).catch(() => {});
    const interval = window.setInterval(refresh, 15000);
    return () => window.clearInterval(interval);
  }, deps);
  useStream((message) => {
    if (shouldRefresh(message)) refresh();
  });
  return [data, setData] as const;
}

export function ago(time?: number) {
  if (!time) return "";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function duration(start?: number, end?: number) {
  if (!start) return "";
  const seconds = Math.round(((end ?? Date.now()) - start) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function useTick(ms = 1000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = window.setInterval(() => setTick((tick) => tick + 1), ms);
    return () => window.clearInterval(interval);
  }, [ms]);
}
