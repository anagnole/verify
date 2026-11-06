import type { WebSocket } from "ws";
import type { ServerResponse } from "node:http";
import { needsFor } from "../shared/types.ts";
import type { EventLevel, FromWorker, RpcMethod, WorkerInfo } from "../shared/types.ts";
import { newId, save, state } from "./store.ts";

export type Worker = {
  id: string;
  info: WorkerInfo;
  socket: WebSocket;
  active: Set<string>;
  connectedAt: number;
  pending: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>;
};

export const workers = new Map<string, Worker>();
const clients = new Set<ServerResponse>();

export function addClient(response: ServerResponse) {
  clients.add(response);
  response.on("close", () => clients.delete(response));
}

export function broadcast(message: unknown) {
  const line = `data: ${JSON.stringify(message)}\n\n`;
  for (const client of clients) client.write(line);
}

setInterval(() => {
  for (const client of clients) client.write(": ping\n\n");
}, 20000);

export function workerView(worker: Worker) {
  let usedCpus = 0;
  let usedMemoryMb = 0;
  for (const runId of worker.active) {
    const run = state.runs[runId];
    if (!run) continue;
    const needs = needsFor(run.target);
    usedCpus += needs.cpus;
    usedMemoryMb += needs.memoryMb;
  }
  return {
    id: worker.id,
    name: worker.info.name,
    region: worker.info.region,
    autoscaled: worker.info.autoscaled,
    kvm: worker.info.kvm,
    android: worker.info.android,
    cpus: worker.info.cpus,
    memoryMb: worker.info.memoryMb,
    usedCpus,
    usedMemoryMb,
    images: worker.info.images.length,
    active: [...worker.active],
    connectedAt: worker.connectedAt,
  };
}

export function broadcastWorkers() {
  broadcast({ type: "workers", workers: [...workers.values()].map(workerView) });
}

export function addEvent(runId: string, level: EventLevel, text: string) {
  const run = state.runs[runId];
  if (!run) return;
  const event = { t: Date.now(), level, text };
  run.events.push(event);
  if (run.events.length > 400) run.events.splice(0, run.events.length - 400);
  broadcast({ type: "event", runId, event });
  save();
}

export function registerWorker(socket: WebSocket) {
  const worker: Worker = {
    id: newId(),
    info: { name: "connecting", cpus: 0, memoryMb: 0, kvm: false, images: [] },
    socket,
    active: new Set(),
    connectedAt: Date.now(),
    pending: new Map(),
  };
  socket.on("error", (error) => console.log(`worker socket error: ${error.message}`));
  socket.on("message", (raw) => {
    let message: FromWorker;
    try {
      message = JSON.parse(String(raw)) as FromWorker;
    } catch {
      return;
    }
    if (message.type === "hello") {
      worker.info = message.info;
      workers.set(worker.id, worker);
      console.log(`worker ${worker.info.name} joined: ${worker.info.cpus} CPUs, ${worker.info.memoryMb} MB, kvm=${worker.info.kvm}`);
      broadcastWorkers();
    } else if (message.type === "images") {
      worker.info.images = message.images;
      broadcastWorkers();
    } else if (message.type === "reply") {
      const pending = worker.pending.get(message.id);
      worker.pending.delete(message.id);
      if (!pending) return;
      if (message.ok) pending.resolve(message.data);
      else pending.reject(new Error(message.error));
    } else if (message.type === "event") {
      addEvent(message.runId, message.level, message.text);
    } else if (message.type === "net") {
      const run = state.runs[message.runId];
      if (!run) return;
      run.net.push(message.entry);
      broadcast({ type: "net", runId: run.id, entry: message.entry });
      save();
    } else if (message.type === "shot") {
      const run = state.runs[message.runId];
      if (!run) return;
      run.liveShots = [...(run.liveShots ?? []), { label: message.label, file: message.file }];
      broadcast({ type: "shot", runId: run.id, shot: { label: message.label, file: message.file } });
      save();
    } else if (message.type === "memory") {
      const run = state.runs[message.runId];
      if (!run) return;
      run.memory.push(message.sample);
      if (run.memory.length > 1200) run.memory.splice(0, 2);
      broadcast({ type: "memory", runId: run.id, sample: message.sample });
    }
  });
  socket.on("close", () => {
    workers.delete(worker.id);
    for (const pending of worker.pending.values()) pending.reject(new Error("worker disconnected"));
    console.log(`worker ${worker.info.name} left`);
    broadcastWorkers();
  });
  return worker;
}

export function call(worker: Worker, method: RpcMethod, params: any): Promise<any> {
  const id = newId();
  return new Promise((resolve, reject) => {
    worker.pending.set(id, { resolve, reject });
    worker.socket.send(JSON.stringify({ type: "call", id, method, params }));
  });
}

export function cancelOnWorker(worker: Worker, runId: string) {
  worker.socket.send(JSON.stringify({ type: "cancel", runId }));
}
