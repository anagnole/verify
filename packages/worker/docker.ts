import { spawn } from "node:child_process";

export type DockerResult = { code: number; stdout: string; stderr: string };

export function docker(
  args: string[],
  options: { input?: NodeJS.ReadableStream; onLine?: (line: string) => void; timeoutMs?: number } = {},
): Promise<DockerResult> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    const handle = (chunk: Buffer, isOut: boolean) => {
      const text = chunk.toString();
      if (isOut) stdout += text;
      else stderr += text;
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
      if (options.onLine) {
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) options.onLine(line);
      }
    };
    child.stdout.on("data", (chunk) => handle(chunk, true));
    child.stderr.on("data", (chunk) => handle(chunk, false));
    const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
    if (options.input) options.input.pipe(child.stdin);
    else child.stdin.end();
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (options.onLine && pending.trim()) options.onLine(pending);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function dockerOk(args: string[]) {
  const result = await docker(args);
  if (result.code !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}

export function follow(args: string[], onLine: (line: string) => void) {
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  let pending = "";
  const feed = (chunk: Buffer) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onLine(line);
  };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  return () => child.kill("SIGKILL");
}
