import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const [mode, appId, flowPath, outDir = "/work/out"] = process.argv.slice(2);
const soakMs = Number(process.env.VERIFY_SOAK_MS ?? 10000);
const startedAt = Date.now();
const steps = [];
const heap = [];
const result = { mode, ok: true, scriptError: null, steps, consoleErrors: [], failedRequests: [], heap, crashed: false };

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

async function adb(...args) {
  const { stdout } = await run("adb", args, { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
  return stdout;
}

async function step(label) {
  const file = `step-${String(steps.length + 1).padStart(2, "0")}.png`;
  await fs.writeFile(path.join(outDir, file), await adb("exec-out", "screencap", "-p"));
  steps.push({ label: String(label), file, at: Date.now() - startedAt });
  console.log(JSON.stringify({ event: "step", label: String(label), file }));
}

async function memoryMb() {
  const text = (await adb("shell", "dumpsys", "meminfo", appId)).toString();
  const match = text.match(/TOTAL PSS:\s+(\d+)/) ?? text.match(/TOTAL\s+(\d+)/);
  return match ? Math.round(Number(match[1]) / 1024) : 0;
}

async function alive() {
  const pid = (await adb("shell", "pidof", appId).catch(() => Buffer.from(""))).toString().trim();
  return pid.length > 0;
}

async function elements() {
  const { stdout } = await run("maestro", ["hierarchy"], { maxBuffer: 64 * 1024 * 1024 }).catch(() => ({ stdout: "{}" }));
  const lines = [];
  const walk = (node) => {
    const attributes = node?.attributes ?? {};
    const id = attributes["resource-id"];
    const text = (attributes.text || attributes["accessibilityText"] || "").trim();
    if ((id || text) && attributes.bounds && lines.length < 80) {
      const parts = [attributes.clickable === "true" ? "clickable" : "view"];
      if (id) parts.push(`id="${id}"`);
      if (text) parts.push(`text="${text.slice(0, 40)}"`);
      if (attributes.checked === "true") parts.push("checked");
      lines.push(parts.join(" "));
    }
    for (const child of node?.children ?? []) walk(child);
  };
  try {
    walk(JSON.parse(stdout.slice(stdout.indexOf("{"))));
  } catch {}
  return lines.join("\n");
}

async function findShots(since) {
  const roots = ["/root/.maestro/tests"];
  const found = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".png") && path.basename(dir) === "takeScreenshot") {
        const stat = await fs.stat(full);
        if (stat.mtimeMs >= since - 1000) found.push(full);
      }
    }
  };
  for (const root of roots) await walk(root);
  return found;
}

function optionalTaps(flow) {
  const lines = flow.split("\n");
  const out = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*- hideKeyboard\s*$/.test(line)) continue;
    const typed = line.match(/^(\s*)- inputText:/);
    if (typed) {
      out.push(line, `${typed[1]}- hideKeyboard`);
      continue;
    }
    const inline = line.match(/^(\s*)- (tapOn|scrollUntilVisible): ["']?([^"'{]+?)["']?\s*$/);
    if (inline && inline[2] === "tapOn") {
      out.push(`${inline[1]}- tapOn:`, `${inline[1]}    text: "${inline[3]}"`, `${inline[1]}    optional: true`);
      continue;
    }
    out.push(line);
    const block = line.match(/^(\s*)- tapOn:\s*$/);
    if (block) {
      const indent = `${block[1]}    `;
      let next = index + 1;
      let hasOptional = false;
      while (next < lines.length && lines[next].startsWith(indent)) {
        if (/^\s*optional:/.test(lines[next])) hasOptional = true;
        next += 1;
      }
      if (!hasOptional) out.push(`${indent}optional: true`);
    }
  }
  return out.join("\n");
}

async function screenSettled() {
  const xml = (await adb("exec-out", "uiautomator", "dump", "/dev/tty").catch(() => Buffer.from(""))).toString();
  const nodes = (xml.match(new RegExp(`package="${appId.replace(/\./g, "\\.")}"`, "g")) ?? []).length;
  return nodes > 8;
}

async function launch() {
  await adb("shell", "wm", "size", "720x1600").catch(() => {});
  await adb("shell", "wm", "density", "320").catch(() => {});
  await adb("shell", "am", "force-stop", appId).catch(() => {});
  await adb("shell", "monkey", "-p", appId, "-c", "android.intent.category.LAUNCHER", "1");
  for (let index = 0; index < 120; index++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await screenSettled()) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return mode === "inspect" ? elements() : "";
    }
  }
  throw new Error("The app did not show its screen within 2 minutes");
}

const sampler = setInterval(async () => {
  try {
    const mb = await memoryMb();
    if (mb) heap.push({ t: Date.now() - startedAt, mb });
  } catch {}
}, 2000);

try {
  const tree = await launch();
  if (mode === "inspect") {
    await fs.writeFile(path.join(outDir, "inspect.png"), await adb("exec-out", "screencap", "-p"));
    result.aria = tree;
    result.elements = tree;
  } else {
    await step("App opened, before any action");
    const flow = await fs.readFile(flowPath, "utf8");
    const shotsDir = path.join(outDir, "maestro");
    await fs.mkdir(shotsDir, { recursive: true });
    const body = optionalTaps(flow.replace(/^appId:.*$/m, "").replace(/^---\s*$/m, "").trim());
    const flowFile = path.join(shotsDir, "flow.yaml");
    await fs.writeFile(flowFile, `appId: ${appId}\n---\n${body}\n`);
    const flowStarted = Date.now();
    const child = spawn("maestro", ["test", flowFile], { cwd: shotsDir });
    let log = "";
    child.stdout.on("data", (chunk) => {
      log += chunk;
      for (const line of chunk.toString().split("\n")) {
        const match = line.match(/Take screenshot (.+?)\.\.\./);
        if (match) console.log(JSON.stringify({ event: "maestro-shot", label: match[1] }));
      }
    });
    child.stderr.on("data", (chunk) => (log += chunk));
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 150000);
      child.on("close", (exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
    });
    const shots = (await findShots(flowStarted)).sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));
    for (const shot of shots) {
      const file = `step-${String(steps.length + 1).padStart(2, "0")}.png`;
      await fs.copyFile(shot, path.join(outDir, file));
      steps.push({ label: path.basename(shot).replace(/\.png$/, "").replace(/^\d+[\s_-]*/, ""), file, at: Date.now() - startedAt });
    }
    if (code !== 0) {
      const failed = log.split("\n").filter((line) => /FAILED|Element not found|Unknown|Error/i.test(line)).slice(0, 5).join("\n");
      throw new Error(`Maestro stopped: ${failed || log.slice(-600)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, soakMs));
    if (!(await alive())) {
      result.crashed = true;
      throw new Error("The app process died during the idle soak");
    }
    await step(`After ${Math.round(soakMs / 1000)} s idle`);
  }
} catch (error) {
  result.ok = false;
  result.scriptError = String(error?.message ?? error).slice(0, 2000);
  if (!(await alive().catch(() => false))) result.crashed = true;
  try {
    await step("Where it stopped");
  } catch {}
}

clearInterval(sampler);
result.durationMs = Date.now() - startedAt;
if (!result.elements) result.elements = await elements().catch(() => "");
result.aria = result.aria ?? result.elements;
await fs.writeFile(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ event: "done", ok: result.ok }));
process.exit(0);
