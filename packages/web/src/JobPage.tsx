import { useEffect, useMemo, useRef, useState } from "react";
import { ago, artifactUrl, duration, getJson, useRefreshing, useStream, useTick } from "./api";
import type { JobView, RunDetail } from "./api";
import { DiffView, MemoryChart, NetLog, StatusPill, statusOf } from "./ui";

const verdictCopy: Record<string, { icon: string; title: string }> = {
  pass: { icon: "✓", title: "Proven working" },
  fail: { icon: "✗", title: "Not done yet" },
  unverified: { icon: "?", title: "Couldn't verify" },
  running: { icon: "◌", title: "Verifying now" },
  queued: { icon: "…", title: "Waiting for a sandbox" },
  cancelled: { icon: "↺", title: "Replaced by a newer verify" },
  skipped: { icon: "–", title: "Skipped" },
};

function Phone({ run }: { run: RunDetail }) {
  const attempt = run.attempts.at(-1);
  const steps = attempt?.result.steps ?? [];
  const live = run.status === "testing" && run.liveShots?.length ? run.liveShots.map((shot) => ({ ...shot, at: 0 })) : [];
  const frames = live.length && (!steps.length || run.liveShots!.length > steps.length) ? live : steps.length ? steps : run.inspectShot ? [{ label: "App as it opened", file: run.inspectShot, at: 0 }] : [];
  const [index, setIndex] = useState<number | null>(null);
  const [video, setVideo] = useState(false);
  const shown = index === null ? Math.max(0, frames.length - 1) : Math.min(index, frames.length - 1);
  const frame = frames[shown];
  useEffect(() => {
    setIndex(null);
    setVideo(false);
  }, [run.id, attempt?.n, frames.length]);

  return (
    <div>
      <div className="phone">
        <div className="phone-screen">
          {video && attempt?.result.video ? (
            <video src={artifactUrl(run.id, attempt.result.video)} autoPlay controls muted playsInline />
          ) : frame ? (
            <img src={artifactUrl(run.id, frame.file)} alt={frame.label} />
          ) : (
            <div className="placeholder">
              {run.status === "queued" ? "Waiting for a free sandbox" : run.status === "done" ? "No screenshots" : "Starting the app in a fresh sandbox…"}
            </div>
          )}
        </div>
      </div>
      <div className="phone-caption">
        <span>{video ? "Screen recording of the run" : frame ? `${shown + 1}/${frames.length} · ${frame.label}` : ""}</span>
        {attempt?.result.video && (
          <button className="button" style={{ padding: "5px 10px", fontSize: 13 }} onClick={() => setVideo(!video)}>
            {video ? "Screenshots" : "▶ Video"}
          </button>
        )}
      </div>
      {frames.length > 1 && !video && (
        <div className="film">
          {frames.map((item, position) => (
            <button key={item.file} className={position === shown ? "active" : ""} onClick={() => setIndex(position)} title={item.label}>
              <img src={artifactUrl(run.id, item.file)} alt={item.label} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const stages = [
  { label: "Sandbox", done: ["App is up", "Metro is serving"] },
  { label: "App running", done: ["Planning the scenario"] },
  { label: "Planning", done: ["Writing the test script"] },
  { label: "Testing", done: ["Judging the screenshots"] },
  { label: "Judging", done: ["Verdict:"] },
  { label: "Destroyed", done: ["Sandbox destroyed"] },
];

function Stages({ run }: { run: RunDetail }) {
  if (run.status === "queued") return null;
  const reached = stages.map((stage) => run.events.findIndex((event) => stage.done.some((prefix) => event.text.startsWith(prefix))));
  const current = reached.findIndex((index) => index === -1);
  const finished = current === -1;
  const lastDoneAt = current > 0 ? run.events[reached[current - 1]]?.t : run.events[0]?.t;
  const blocks = run.events.filter((event) => event.level === "block");
  return (
    <div className="stages-wrap">
      <div className="stages">
        {stages.map((stage, index) => {
          const state = finished || index < current ? "done" : index === current && run.status !== "done" && run.status !== "cancelled" ? "active" : "todo";
          return (
            <div key={stage.label} className={`stage ${state}`}>
              <span className="stage-dot">{state === "done" ? "✓" : state === "active" ? <span className="spin" /> : ""}</span>
              <span className="stage-label">
                {stage.label}
                {state === "active" && lastDoneAt ? <span className="stage-time"> {Math.round((Date.now() - lastDoneAt) / 1000)}s</span> : null}
              </span>
            </div>
          );
        })}
      </div>
      {blocks.map((event, index) => (
        <div key={index} className="contain-alert">
          <b>Contained:</b> {event.text}
        </div>
      ))}
    </div>
  );
}

function Log({ run }: { run: RunDetail }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [run.events.length]);
  const start = run.events[0]?.t ?? 0;
  return (
    <div className="log" ref={box}>
      {run.events.map((event, index) => (
        <div key={index} className="line">
          <span className="time">+{((event.t - start) / 1000).toFixed(1)}s</span>
          <span className={event.level}>{event.text}</span>
        </div>
      ))}
      {run.events.length === 0 && <div className="empty-note">Waiting for a sandbox…</div>}
    </div>
  );
}

function RunView({ runId }: { runId: string }) {
  useTick(1000);
  const [run, setRun] = useRefreshing<RunDetail>(
    () => getJson(`/api/runs/${runId}`),
    (message) => message.type === "run" && message.run.id === runId,
    [runId],
  );
  useStream((message) => {
    if (message.runId !== runId) return;
    setRun((current) => {
      if (!current) return current;
      if (message.type === "event") return { ...current, events: [...current.events, message.event] };
      if (message.type === "net") return { ...current, net: [...current.net, message.entry] };
      if (message.type === "memory") return { ...current, memory: [...current.memory, message.sample] };
      if (message.type === "shot") return { ...current, liveShots: [...(current.liveShots ?? []), message.shot] };
      return current;
    });
  });
  if (!run) return <div className="panel empty-note">Loading run…</div>;

  const attempt = run.attempts.at(-1);
  const blocked = run.net.filter((entry) => entry.action === "blocked");
  const killed = run.attempts.some((item) => item.oomKilled);
  const destroyed = run.events.some((event) => event.text.startsWith("Sandbox destroyed"));
  const checks = run.scenario?.checks ?? [];

  return (
    <>
    <Stages run={run} />
    <div className="run-grid">
      <Phone run={run} />
      <div>
        {!!run.bugs?.length && (
          <div className="panel">
            <div className="panel-title" style={{ color: "var(--fail)" }}>Bugs found</div>
            {run.bugs.map((bug, index) => (
              <div key={index} className="bug">
                <div className="title">{bug.title}</div>
                {!!bug.repro?.length && (
                  <ol>
                    {bug.repro.map((step, position) => (
                      <li key={position}>{step}</li>
                    ))}
                  </ol>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="panel">
          <div className="panel-title">
            {run.scenario ? run.scenario.title : "Scenario"}
            <span className="spacer" />
            <span className="hint">written by the verifier before the run</span>
          </div>
          {checks.length === 0 && <div className="empty-note">The verifier plans its checks after it has seen the app and the diff.</div>}
          <div className="checks">
            {checks.map((check) => (
              <div key={check.id} className="check">
                <span className={`mark ${check.result ?? "pending"}`}>{check.result === "pass" ? "✓" : check.result === "fail" ? "✗" : check.result ? "?" : "·"}</span>
                <div>
                  <div className="do">{check.do}</div>
                  <div className="expect">Expect: {check.expect}</div>
                  {check.evidence && <div className="evidence">{check.evidence}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            Containment
            <span className="spacer" />
            {blocked.length > 0 && <span className="pill fail">{blocked.length} blocked</span>}
            {killed && <span className="pill fail">killed at memory cap</span>}
          </div>
          <div className="contain">
            <div>
              <div className="k">Sandbox</div>
              <div className="v">2 CPU · {((run.memoryCapMb ?? 3072) / 1024).toFixed(0)} GB cap</div>
            </div>
            <div>
              <div className="k">Network</div>
              <div className="v">{run.job.recipe.allow?.length ? `only ${run.job.recipe.allow.join(", ")}` : "registry only, then nothing"}</div>
            </div>
            <div>
              <div className="k">Secrets inside</div>
              <div className="v">none</div>
            </div>
            <div>
              <div className="k">Lifecycle</div>
              <div className="v" style={{ color: destroyed ? "var(--pass)" : undefined }}>
                {destroyed ? "destroyed after run" : run.status === "queued" ? "not started" : "live"}
              </div>
            </div>
          </div>
          <NetLog entries={run.net} />
          <div className="chart">
            <MemoryChart samples={run.memory} capMb={run.memoryCapMb} killed={killed} />
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            Live log
            <span className="spacer" />
            <span className="hint">
              {run.worker ? `${run.worker}${run.cold === undefined ? "" : run.cold ? " · cold start" : " · warm start"}` : "waiting"}
              {run.startedAt ? ` · ${duration(run.startedAt, run.finishedAt)}` : ""}
            </span>
          </div>
          <Log run={run} />
          {attempt && (
            <details className="code">
              <summary>
                Test script{run.attempts.length > 1 ? ` (attempt ${attempt.n}, fixed ${run.attempts.length - 1}×)` : ""}
              </summary>
              <pre>{attempt.script}</pre>
            </details>
          )}
          <details className="code">
            <summary>The change ({run.job.repo} · {run.job.branch})</summary>
            <DiffView diff={run.job.diff} />
          </details>
          <details className="code">
            <summary>verify.yml</summary>
            <pre>{`install: ${run.job.recipe.install}\nstart: ${run.job.recipe.start}\nready: ${run.job.recipe.ready}${run.job.recipe.allow?.length ? `\nallow: [${run.job.recipe.allow.join(", ")}]` : ""}`}</pre>
          </details>
        </div>
      </div>
    </div>
    </>
  );
}

export default function JobPage({ id }: { id: string }) {
  useTick(1000);
  const [job] = useRefreshing<JobView>(
    () => getJson(`/api/jobs/${id}`),
    (message) => (message.type === "job" && message.job.id === id) || (message.type === "run" && message.run.jobId === id),
    [id],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const runId = useMemo(() => selected ?? job?.runs.find((run) => run.verdict === "fail")?.id ?? job?.runs[0]?.id, [selected, job]);
  if (!job) return <div className="job-header muted">Loading…</div>;
  const state = statusOf(job);
  const copy = verdictCopy[state] ?? verdictCopy.running;
  const tone = state === "cancelled" || state === "skipped" || state === "queued" ? "unverified" : state;

  return (
    <>
      <div className="job-header">
        <a href="#/" className="back">
          ← All verifications
        </a>
        <h1>{job.message}</h1>
        <div className="meta">
          <StatusPill item={job} />
          {job.targets.map((target) => (
            <span key={target} className="chip">
              {target === "web" ? "web · Chromium" : target.startsWith("android") ? `Android ${target.split("-")[1] === "34" ? "14" : target.split("-")[1]} · emulator` : target}
            </span>
          ))}
          <span>{job.repo}</span>
          <span className="chip">{job.branch}</span>
          {job.commit && (
            <span className="chip" title="The exact code that was tested">
              {job.commit}
              {job.dirty ? ` + ${job.dirty} uncommitted` : ""}
            </span>
          )}
          <span>by {job.agent}</span>
          <span>{ago(job.createdAt)}</span>
          {job.finishedAt && <span>took {duration(job.createdAt, job.finishedAt)}</span>}
        </div>
        <div className={`verdict-banner ${tone}`}>
          <div className="icon">{copy.icon}</div>
          <div>
            <div className="title">{copy.title}</div>
            <div className="text">
              {job.summary ??
                (state === "queued"
                  ? `Waiting for a free sandbox${job.runs[0]?.position ? `, #${job.runs[0].position} in line` : ""}.`
                  : "An independent agent is testing this change in a fresh sandbox.")}
            </div>
            {job.supersededBy && (
              <div className="text" style={{ marginTop: 6 }}>
                <a href={`#/jobs/${job.supersededBy}`} style={{ textDecoration: "underline" }}>
                  Open the newer verify →
                </a>
              </div>
            )}
          </div>
        </div>
        {job.runs.length > 1 && (
          <div className="tabs">
            {job.runs.map((run) => (
              <button key={run.id} className={`tab ${run.id === runId ? "active" : ""}`} onClick={() => setSelected(run.id)}>
                {run.target}
                <StatusPill item={run} />
              </button>
            ))}
          </div>
        )}
      </div>
      {runId && <RunView runId={runId} />}
    </>
  );
}
