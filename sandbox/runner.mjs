import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const [mode, url, scriptPath, outDir = "/work/out"] = process.argv.slice(2);
const viewport = { width: 390, height: 844 };
const startedAt = Date.now();
const soakMs = Number(process.env.VERIFY_SOAK_MS ?? 10000);

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  proxy: process.env.VERIFY_PROXY ? { server: process.env.VERIFY_PROXY, bypass: "localhost,127.0.0.1" } : undefined,
});
const context = await browser.newContext({
  viewport,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  recordVideo: mode === "run" ? { dir: outDir, size: viewport } : undefined,
});
const page = await context.newPage();
page.setDefaultTimeout(8000);

const steps = [];
const consoleErrors = [];
const failedRequests = [];
const heap = [];
let crashed = false;

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text().slice(0, 500));
});
page.on("pageerror", (error) => consoleErrors.push(String(error).slice(0, 500)));
page.on("requestfailed", (request) => {
  const url = request.url();
  if (!url.startsWith("data:")) failedRequests.push({ url: url.slice(0, 300), error: request.failure()?.errorText });
});
page.on("crash", () => {
  crashed = true;
});

const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
const sampler = setInterval(async () => {
  try {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const used = metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0;
    heap.push({ t: Date.now() - startedAt, mb: Math.round(used / 1048576) });
  } catch {}
}, 500);

async function step(label) {
  const file = `step-${String(steps.length + 1).padStart(2, "0")}.png`;
  await page.screenshot({ path: path.join(outDir, file) });
  steps.push({ label: String(label), file, at: Date.now() - startedAt });
  console.log(JSON.stringify({ event: "step", label: String(label), file }));
}

async function listElements() {
  return page.$$eval("[data-testid], button, [role=button], [role=checkbox], input, textarea, a[href]", (nodes) =>
    nodes
      .filter((node) => node.getClientRects().length > 0)
      .slice(0, 80)
      .map((node) => {
        const parts = [node.getAttribute("role") ?? node.tagName.toLowerCase()];
        if (node.dataset.testid) parts.push(`testid="${node.dataset.testid}"`);
        const label = node.getAttribute("aria-label");
        if (label) parts.push(`label="${label}"`);
        const text = (node.innerText ?? node.value ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
        if (text) parts.push(`text="${text}"`);
        return parts.join(" ");
      })
      .join("\n"),
  );
}

async function openApp() {
  await page.goto(url, { waitUntil: "load", timeout: 180000 });
  await page.waitForFunction(() => (document.getElementById("root")?.innerText ?? "").trim().length > 0, null, {
    timeout: 180000,
  });
  await page.waitForTimeout(500);
}

const result = { mode, ok: true, scriptError: null, steps, consoleErrors, failedRequests, heap, crashed };

try {
  await openApp();
  if (mode === "inspect") {
    await page.screenshot({ path: path.join(outDir, "inspect.png") });
    result.title = await page.title();
    result.aria = (await page.locator("body").ariaSnapshot()).slice(0, 6000);
    result.elements = await listElements();
  } else {
    const module = await import(path.resolve(scriptPath));
    const script = { default: typeof module.default === "function" ? module.default : Object.values(module).find((value) => typeof value === "function") };
    if (!script.default) throw new SyntaxError("The script does not export a function");
    await step("App opened, before any action");
    let timer;
    await Promise.race([
      script.default({ page, step }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Script timed out after 120 s")), 120000);
      }),
    ]).finally(() => clearTimeout(timer));
    await page.waitForTimeout(soakMs);
    await step(`After ${Math.round(soakMs / 1000)} s idle`);
  }
} catch (error) {
  result.ok = false;
  result.scriptError = String(error?.stack ?? error).slice(0, 2000);
  try {
    await step("Where it stopped");
  } catch {}
}

clearInterval(sampler);
result.crashed = crashed;
result.durationMs = Date.now() - startedAt;
try {
  result.aria = result.aria ?? (await page.locator("body").ariaSnapshot()).slice(0, 6000);
  result.elements = result.elements ?? (await listElements());
} catch {}
await context.close().catch(() => {});
await browser.close().catch(() => {});

const videos = (await fs.readdir(outDir)).filter((file) => file.endsWith(".webm"));
if (videos[0]) {
  await fs.rename(path.join(outDir, videos[0]), path.join(outDir, "video.webm"));
  result.video = "video.webm";
}
await fs.writeFile(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ event: "done", ok: result.ok }));
process.exit(0);
