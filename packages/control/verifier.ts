import path from "node:path";
import { needsFor } from "../shared/types.ts";
import { addEvent, broadcast, call } from "./hub.ts";
import type { Worker } from "./hub.ts";
import { fixScript, judge, planScenario, writeScript } from "./llm.ts";
import { dataDir, save, state } from "./store.ts";
import type { Job, Run } from "./store.ts";

function artifact(run: Run, name: string) {
  return path.join(dataDir, "artifacts", run.id, name);
}

function looksLikeScriptProblem(error: string) {
  return /locator|selector|strict mode|waiting for|SyntaxError|is not a function|ReferenceError|TypeError|Unexpected token|timed out after 120|Maestro stopped|Element not found|Invalid command|Unknown/i.test(error);
}

function stillLive(run: Run) {
  return run.status !== "cancelled";
}

export function updateRun(run: Run, patch: Partial<Run>) {
  Object.assign(run, patch);
  broadcast({ type: "run", run: { id: run.id, jobId: run.jobId, status: run.status, verdict: run.verdict, summary: run.summary } });
  save();
}

export async function verifyRun(run: Run, job: Job, worker: Worker) {
  const say = (level: Parameters<typeof addEvent>[1], text: string) => addEvent(run.id, level, text);
  const needs = needsFor(run.target);
  updateRun(run, { status: "preparing", startedAt: Date.now(), worker: worker.info.name, memoryCapMb: needs.memoryMb });
  say("info", `Placed on ${worker.info.name}${worker.info.autoscaled ? " (autoscaled)" : ""}`);

  try {
    const prepared = await call(worker, "prepare", {
      runId: run.id,
      repo: job.repo,
      lockHash: job.lockHash,
      recipe: job.recipe,
      sourceUrl: `/api/sources/${job.id}`,
      target: run.target,
      needs,
    });
    updateRun(run, { cold: prepared.cold, prepareSeconds: prepared.seconds });
    if (!stillLive(run)) return;
    if (!prepared.ok) {
      const blocked = run.net.filter((entry) => entry.action === "blocked");
      if (blocked.length) {
        const result = await judge({
          message: job.message,
          checks: [],
          steps: [],
          facts: [
            ...blocked.map((entry) => `During ${entry.phase} something tried to reach ${entry.host} and was blocked`),
            `Setup failed: ${String(prepared.error).slice(0, 400)}`,
          ],
        }).catch(() => null);
        return finishRun(run, "fail", result?.summary ?? "Setup tried to reach blocked hosts and failed.", result?.bugs ?? []);
      }
      return finishRun(run, "unverified", `The app could not be started, so nothing was verified. ${String(prepared.error).slice(0, 300)}`, []);
    }

    const inspected = await call(worker, "inspect", { runId: run.id });
    if (!stillLive(run)) return;
    if (!inspected.ok) return finishRun(run, "unverified", `The app opened but could not be read: ${inspected.error ?? ""}`, []);
    updateRun(run, { inspectShot: inspected.screenshot, status: "testing" });

    say("step", "Planning the scenario from the diff and the screen");
    const scenario = await planScenario({
      message: job.message,
      diff: job.diff,
      target: run.target,
      aria: inspected.aria ?? "",
      screenshot: artifact(run, inspected.screenshot),
    });
    updateRun(run, { scenario: { title: scenario.title, checks: scenario.checks } });
    say("info", `Scenario: ${scenario.title}`);
    for (const check of scenario.checks) say("info", `Check: ${check.do} → ${check.expect}`);

    say("step", "Writing the test script");
    const android = run.target.startsWith("android");
    let script = await writeScript({ checks: scenario.checks, aria: inspected.aria ?? "", elements: inspected.elements, message: job.message, android });
    let last: any = null;
    for (let n = 1; n <= 2; n++) {
      if (!stillLive(run)) return;
      const executed = await call(worker, "exec", { runId: run.id, attempt: n, script });
      last = executed;
      run.attempts.push({ n, script, result: executed.result, oomKilled: executed.oomKilled });
      save();
      broadcast({ type: "run", run: { id: run.id, jobId: run.jobId, status: run.status } });
      const error = executed.result.scriptError ?? "";
      if (executed.oomKilled || executed.result.crashed) break;
      if (!error) break;
      const progressed = executed.result.steps.length > 2;
      const broken = /SyntaxError|ReferenceError|is not a function|Unexpected token|does not export/.test(error);
      if (n === 2 || !looksLikeScriptProblem(error) || (progressed && !broken)) break;
      say("warn", `The script itself broke (${error.split("\n")[0].slice(0, 120)}). Fixing it and trying again.`);
      const lastStep = executed.result.steps.at(-1);
      script = await fixScript({
        script,
        error,
        aria: executed.result.aria,
        elements: executed.result.elements,
        android,
        screenshot: lastStep ? artifact(run, lastStep.file) : undefined,
      });
      run.attempts[run.attempts.length - 1].fixedBecause = error.split("\n")[0].slice(0, 200);
    }
    if (!stillLive(run)) return;

    const judgeAttempt = async (attempt: any) => {
      updateRun(run, { status: "judging" });
      say("step", "Judging the screenshots against the checks");
      const result = attempt.result;
      const facts: string[] = [];
      const peak = Math.max(0, ...run.memory.map((sample) => sample.mb));
      if (attempt.oomKilled) facts.push(`The sandbox memory cap (${needs.memoryMb} MB) was reached and the app's browser process was killed. Peak sandbox memory ${peak} MB.`);
      else if (result.crashed) facts.push("The page crashed during the run.");
      if (result.scriptError) facts.push(`The test stopped early: ${result.scriptError.split("\n")[0].slice(0, 300)}`);
      for (const entry of run.net.filter((item) => item.action === "blocked")) {
        facts.push(`During ${entry.phase}, something tried to reach ${entry.host} (${entry.kind}) and the sandbox blocked it.`);
      }
      for (const message of result.consoleErrors.slice(0, 5)) facts.push(`Console error: ${message.slice(0, 200)}`);
      const heapPeak = Math.max(0, ...result.heap.map((sample: any) => sample.mb));
      if (heapPeak) facts.push(`Page JS heap peaked at ${heapPeak} MB.`);
      return judge({
        message: job.message,
        checks: scenario.checks,
        steps: result.steps.map((step: any) => ({ label: step.label, file: artifact(run, step.file) })),
        facts,
      });
    };

    let judgement = await judgeAttempt(last);
    const stopError: string = last.result.scriptError ?? "";
    const stoppedEarly = stopError && !last.oomKilled && !last.result.crashed && looksLikeScriptProblem(stopError);
    const nothingFailed = !judgement.checks.some((check: any) => check.result === "fail");
    if (judgement.verdict === "unverified" && stoppedEarly && nothingFailed && run.attempts.length < 2 && stillLive(run)) {
      say("warn", `The script stopped before the last checks (${stopError.split("\n")[0].slice(0, 120)}). Fixing it and running every check again.`);
      const lastStep = last.result.steps.at(-1);
      script = await fixScript({
        script,
        error: stopError,
        aria: last.result.aria,
        elements: last.result.elements,
        android,
        screenshot: lastStep ? artifact(run, lastStep.file) : undefined,
      });
      run.attempts[run.attempts.length - 1].fixedBecause = stopError.split("\n")[0].slice(0, 200);
      updateRun(run, { status: "testing" });
      say("step", "Running the test scenario again");
      last = await call(worker, "exec", { runId: run.id, attempt: 2, script });
      run.attempts.push({ n: 2, script, result: last.result, oomKilled: last.oomKilled });
      save();
      if (!stillLive(run)) return;
      judgement = await judgeAttempt(last);
    }
    const byId = new Map(judgement.checks.map((check) => [check.id, check]));
    const checks = scenario.checks.map((check) => ({ ...check, ...byId.get(check.id) }));
    updateRun(run, { scenario: { title: scenario.title, checks } });
    return finishRun(run, judgement.verdict, judgement.summary, judgement.bugs ?? []);
  } catch (error: any) {
    if (!stillLive(run)) return;
    say("error", String(error?.message ?? error));
    return finishRun(run, "unverified", `Verification broke down: ${String(error?.message ?? error).slice(0, 300)}`, []);
  } finally {
    await call(worker, "finish", { runId: run.id }).catch(() => {});
  }
}

function finishRun(run: Run, verdict: Run["verdict"], summary: string, bugs: Run["bugs"]) {
  if (!stillLive(run)) return;
  addEvent(run.id, verdict === "pass" ? "ok" : "error", `Verdict: ${String(verdict).toUpperCase()}. ${summary}`);
  updateRun(run, { status: "done", verdict, summary, bugs, finishedAt: Date.now() });
}
