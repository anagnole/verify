#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";

const configFile = path.join(os.homedir(), ".config", "verify", "config.json");
const color = (process.stdout.isTTY || Boolean(process.env.FORCE_COLOR)) && !process.env.NO_COLOR;
const paint = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (text: string) => paint("1", text);
const dim = (text: string) => paint("2", text);
const red = (text: string) => paint("31", text);
const green = (text: string) => paint("32", text);
const yellow = (text: string) => paint("33", text);

const recipeTemplate = `install: npm install
start: npm run dev -- --port 3000
ready: http://localhost:3000
platforms: [web]
allow: []
android_apk: https://example.com/builds/app-debug.apk
android_package: com.example.app
android_start: npx expo start --port 8081
`;

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch {
    return {};
  }
}

function git(args: string[], cwd: string) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function parseRecipe(text: string) {
  const values: Record<string, any> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!match) continue;
    const raw = match[2].trim();
    values[match[1]] = raw.startsWith("[") ? raw.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean) : raw;
  }
  return {
    install: values.install,
    start: values.start,
    ready: values.ready,
    platforms: values.platforms ?? ["web"],
    allow: values.allow ?? [],
    android_apk: values.android_apk,
    android_package: values.android_package,
    android_start: values.android_start,
  };
}

function baseRef(root: string) {
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    const base = git(["merge-base", "HEAD", ref], root);
    if (base) return base;
  }
  return "HEAD";
}

function collectDiff(root: string) {
  const base = baseRef(root);
  let diff = git(["diff", base], root);
  if (!diff) diff = git(["diff", "HEAD~1"], root);
  const untracked = git(["ls-files", "--others", "--exclude-standard"], root).split("\n").filter(Boolean);
  for (const file of untracked.slice(0, 20)) {
    const full = path.join(root, file);
    if (!fs.existsSync(full) || fs.statSync(full).size > 100_000) continue;
    diff += `\n\nNew file ${file}:\n${fs.readFileSync(full, "utf8").split("\n").slice(0, 200).join("\n")}`;
  }
  return diff;
}

function lockHash(root: string) {
  for (const name of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock"]) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  return "nolock";
}

function packSource(root: string): Promise<Buffer> {
  const files = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root)
    .split("\0")
    .filter((file) => file && !/(^|\/)\.env(\.|$)/.test(file) && !file.startsWith("node_modules/") && fs.existsSync(path.join(root, file)));
  const extra = process.platform === "darwin" ? ["--no-xattrs", "--no-mac-metadata"] : [];
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", [...extra, "-czf", "-", "--null", "-T", "-"], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const chunks: Buffer[] = [];
    tar.stdout.on("data", (chunk) => chunks.push(chunk));
    tar.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar exited ${code}`))));
    tar.stdin.end(files.join("\0"));
  });
}

async function api(server: string, token: string, method: string, route: string, body?: unknown) {
  const response = await fetch(`${server}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body instanceof Buffer ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `${method} ${route} failed with ${response.status}`);
  return data;
}

function mark(result?: string) {
  if (result === "pass") return green("✓");
  if (result === "fail") return red("✗");
  return yellow("?");
}

function verdictLabel(verdict?: string) {
  if (verdict === "pass") return green(bold("PASS"));
  if (verdict === "fail") return red(bold("FAIL"));
  return yellow(bold("COULDN'T VERIFY"));
}

async function main() {
  const args = process.argv.slice(2);
  const config = readConfig();

  if (args[0] === "login") {
    const [server, token] = args.slice(1);
    if (!server || !token) {
      console.log("usage: verify login <server-url> <token>");
      process.exit(2);
    }
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ server: server.replace(/\/$/, ""), token }, null, 2), { mode: 0o600 });
    console.log(`Saved. verify will use ${server}`);
    return;
  }

  let targets: string[] | undefined;
  let wait = true;
  const words: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--on") targets = args[++index].split(",").map((item) => item.trim());
    else if (arg === "--no-wait") wait = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(`verify "what you changed and what to check" [--on web,android-34] [--no-wait]
verify login <server-url> <token>

Run it when you think you are done. It uploads your working tree to the verify server,
an independent agent tests the change in a fresh sandbox, and you get proof back.
Exit code 0 = pass, 1 = fail, 2 = could not verify.`);
      return;
    } else words.push(arg);
  }
  const message = words.join(" ").trim();
  if (!message) {
    console.error('Say what you changed: verify "added a delete button to each item"');
    process.exit(2);
  }

  const server = (process.env.VERIFY_SERVER ?? config.server ?? "http://localhost:7300").replace(/\/$/, "");
  const token = process.env.VERIFY_TOKEN ?? config.token ?? "dev-token";
  const root = git(["rev-parse", "--show-toplevel"], process.cwd());
  if (!root) {
    console.error("verify needs to run inside a git repository.");
    process.exit(2);
  }
  const recipeFile = path.join(root, "verify.yml");
  if (!fs.existsSync(recipeFile)) {
    console.error(`No verify.yml in ${root}.

Create it with the commands that install and start this project, for example:

${recipeTemplate}
- install: installs dependencies (runs once per lockfile, then it is cached)
- start: starts the dev server in the foreground
- ready: a URL that answers once the app is up
- platforms: web, and android-34 for the Android emulator
- allow: hosts the app may call while it runs (everything else is blocked)
- android_*: only for Android runs. A debug build of the app (APK URL), its package id, and the
  command that starts Metro. JS changes are tested on that build without rebuilding it.

Then run verify again.`);
    process.exit(3);
  }
  const recipe = parseRecipe(fs.readFileSync(recipeFile, "utf8"));
  const repo = path.basename(git(["config", "--get", "remote.origin.url"], root).replace(/\.git$/, "")) || path.basename(root);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], root) || "main";

  const source = await packSource(root);
  const commit = git(["rev-parse", "--short", "HEAD"], root);
  const dirty = git(["status", "--porcelain"], root).split("\n").filter(Boolean).length;
  const created = await api(server, token, "POST", "/api/jobs", {
    repo,
    branch,
    agent: process.env.VERIFY_AGENT ?? (process.env.CLAUDECODE ? "claude-code" : "cli"),
    host: os.hostname(),
    message,
    targets: targets ?? recipe.platforms,
    lockHash: lockHash(root),
    recipe,
    diff: collectDiff(root),
    commit,
    dirty,
  });
  await api(server, token, "PUT", created.upload, source);
  const link = `${server}/#/jobs/${created.id}`;
  console.log(`${bold("verify")} ${dim(`job ${created.id} · ${(source.length / 1024).toFixed(0)} KB uploaded`)}`);
  console.log(dim(link));
  if (!wait) return;

  const seen = new Set<string>();
  let lastPosition = "";
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const job = await api(server, token, "GET", `/api/jobs/${created.id}`);
    for (const run of job.runs) {
      if (run.status === "queued" && run.position) {
        const eta = Math.round((run.position * job.averageSeconds) / Math.max(1, job.workers));
        const line = `${run.target}: ${run.position === 1 ? "next in line" : `#${run.position} in line`}, about ${eta} s`;
        if (line !== lastPosition) console.log(dim(line));
        lastPosition = line;
      }
      for (const event of run.events ?? []) {
        const key = `${run.id}${event.t}${event.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!["step", "block", "warn", "ok", "error"].includes(event.level) || event.text.startsWith("Verdict:")) continue;
        const text = event.level === "block" ? red(event.text) : event.level === "warn" ? yellow(event.text) : event.text;
        console.log(`${dim(run.target.padEnd(10))} ${text}`);
      }
    }
    if (job.status === "done" || job.status === "cancelled") {
      console.log("");
      if (job.status === "cancelled") {
        console.log(`${yellow(bold("CANCELLED"))} ${job.summary ?? ""}`);
        process.exit(2);
      }
      console.log(`${verdictLabel(job.verdict)}  ${message}`);
      for (const run of job.runs) {
        if (run.status === "skipped") {
          console.log(`  ${run.target}: ${dim(run.summary)}`);
          continue;
        }
        console.log(`  ${bold(run.target)} ${verdictLabel(run.verdict)} ${run.summary ?? ""}`);
        for (const check of run.checks ?? []) {
          console.log(`    ${mark(check.result)} ${check.do}`);
          if (check.result !== "pass" && check.evidence) console.log(dim(`      ${check.evidence.length > 220 ? `${check.evidence.slice(0, 217)}…` : check.evidence}`));
        }
        for (const bug of run.bugs ?? []) {
          console.log(`    ${red("Bug:")} ${bug.title}`);
          (bug.repro ?? []).forEach((step: string, index: number) => console.log(`      ${index + 1}. ${step}`));
        }
      }
      console.log(`\nProof: ${link}`);
      process.exit(job.verdict === "pass" ? 0 : job.verdict === "fail" ? 1 : 2);
    }
  }
}

main().catch((error) => {
  console.error(`verify: ${error.message}`);
  process.exit(2);
});
