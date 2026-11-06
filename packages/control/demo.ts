import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { dataDir } from "./store.ts";
import type { Recipe } from "../shared/types.ts";

export const demoDir = path.resolve(process.env.VERIFY_DEMO_DIR ?? path.join(import.meta.dirname, "../../demo-app"));

export type Change = { id: string; title: string; message: string; blurb: string; expect: string };

export const changes: Change[] = [
  {
    id: "clear-packed",
    title: "Clear packed items",
    message: "Added a Clear packed button that removes every packed item from the list",
    blurb: "A small feature that works. The verifier should prove it and pass.",
    expect: "pass",
  },
  {
    id: "delete-item",
    title: "Delete an item",
    message: "Added a delete button to each item so you can remove things from the list",
    blurb: "Looks done. There is a bug planted in it. See whether the verifier finds it and explains it.",
    expect: "fail",
  },
  {
    id: "haptics-package",
    title: "Haptic feedback",
    message: "Added haptic feedback when you pack an item, using a small haptics package",
    blurb: "The agent pulled in a package whose install script tries to send your environment out.",
    expect: "blocked",
  },
  {
    id: "last-saved-clock",
    title: "Last saved clock",
    message: "Added a live 'last saved' clock to the header",
    blurb: "A timer bug that keeps eating memory until the sandbox cap kills it.",
    expect: "memory",
  },
];

function lockHashOf(dir: string) {
  for (const name of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  return "nolock";
}

function readRecipe(dir: string): Recipe {
  const text = fs.readFileSync(path.join(dir, "verify.yml"), "utf8");
  return parseRecipe(text);
}

export function parseRecipe(text: string): Recipe {
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

export function buildTrySource(change: Change, jobId: string) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "verify-try-"));
  const app = path.join(work, "app");
  fs.cpSync(demoDir, app, {
    recursive: true,
    filter: (source) => !/\/(node_modules|\.expo|changes|dist)(\/|$)/.test(source.slice(demoDir.length)),
  });
  const patch = path.join(demoDir, "changes", `${change.id}.patch`);
  execFileSync("git", ["apply", "--binary", patch], { cwd: app });
  const archive = path.join(dataDir, "sources", `${jobId}.tgz`);
  execFileSync("tar", ["-czf", archive, "-C", app, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const result = { lockHash: lockHashOf(app), recipe: readRecipe(app), diff: textOnly(fs.readFileSync(patch, "utf8")) };
  fs.rmSync(work, { recursive: true, force: true });
  return result;
}

function textOnly(patch: string) {
  const out: string[] = [];
  let skipping = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git")) skipping = false;
    if (line.startsWith("GIT binary patch")) {
      skipping = true;
      out.push("(binary file)");
      continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}
