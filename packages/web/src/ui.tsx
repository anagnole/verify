import type { NetEntry, RunSummary, Verdict } from "./api";

export function statusOf(item: { status: string; verdict?: Verdict }) {
  if (item.status === "done") return item.verdict ?? "unverified";
  if (item.status === "cancelled") return "cancelled";
  if (item.status === "skipped") return "skipped";
  if (item.status === "queued") return "queued";
  return "running";
}

const labels: Record<string, string> = {
  pass: "PASS",
  fail: "FAIL",
  unverified: "COULDN'T VERIFY",
  running: "VERIFYING",
  queued: "QUEUED",
  cancelled: "REPLACED",
  skipped: "SKIPPED",
  preparing: "PREPARING",
  testing: "TESTING",
  judging: "JUDGING",
};

export function StatusPill({ item, big, detail }: { item: { status: string; verdict?: Verdict }; big?: boolean; detail?: boolean }) {
  const state = statusOf(item);
  const tone = state === "queued" || state === "cancelled" || state === "skipped" ? "muted" : state;
  const text = detail && state === "running" ? labels[item.status] ?? "VERIFYING" : labels[state];
  return (
    <span className={`pill ${tone}${big ? " big" : ""}`}>
      {state === "running" && <span className="spin" />}
      {text}
    </span>
  );
}

export function TargetPill({ run }: { run: RunSummary }) {
  const state = statusOf(run);
  const tone = state === "queued" || state === "cancelled" || state === "skipped" ? "muted" : state;
  return (
    <span className={`pill ${tone}`}>
      {state === "running" && <span className="spin" />}
      {run.target}
      {state === "queued" && run.position ? ` · #${run.position}` : ""}
    </span>
  );
}

export function MemoryChart({ samples, capMb, killed }: { samples: { t: number; mb: number }[]; capMb?: number; killed?: boolean }) {
  const width = 600;
  const height = 120;
  if (samples.length < 2) {
    return <div className="empty-note">Memory samples appear once the app is running.</div>;
  }
  const cap = capMb ?? Math.max(...samples.map((sample) => sample.mb)) * 1.2;
  const top = Math.max(cap, ...samples.map((sample) => sample.mb)) * 1.05;
  const t0 = samples[0].t;
  const t1 = samples[samples.length - 1].t;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * width;
  const y = (mb: number) => height - (mb / top) * height;
  const line = samples.map((sample, index) => `${index ? "L" : "M"}${x(sample.t).toFixed(1)},${y(sample.mb).toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const peak = Math.max(...samples.map((sample) => sample.mb));
  const capY = y(cap);
  return (
    <>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="memfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={killed ? "#b3362b" : "#2557a7"} stopOpacity="0.35" />
            <stop offset="1" stopColor={killed ? "#b3362b" : "#2557a7"} stopOpacity="0" />
          </linearGradient>
        </defs>
        {capMb && <line x1="0" x2={width} y1={capY} y2={capY} stroke="#b3362b" strokeDasharray="6 5" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
        <path d={area} fill="url(#memfill)" />
        <path d={line} fill="none" stroke={killed ? "#b3362b" : "#2557a7"} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="legend">
        <span>Sandbox memory · peak {peak} MB</span>
        {capMb && <span style={{ color: "var(--fail)" }}>cap {capMb} MB</span>}
      </div>
    </>
  );
}

export function NetLog({ entries }: { entries: NetEntry[] }) {
  const grouped: (NetEntry & { count: number })[] = [];
  for (const entry of entries) {
    const last = grouped.find((item) => item.host === entry.host && item.action === entry.action && item.phase === entry.phase);
    if (last) last.count += 1;
    else grouped.push({ ...entry, count: 1 });
  }
  if (!grouped.length) return <div className="empty-note">No traffic left the sandbox.</div>;
  return (
    <div className="netlog">
      {grouped.map((entry, index) => (
        <div key={index} className={`row ${entry.action === "blocked" ? "blocked" : ""}`}>
          <span>{entry.action === "blocked" ? "BLOCKED" : "allowed"}</span>
          <span className="kind">{entry.kind}</span>
          <span>{entry.phase}</span>
          <span className="host">
            {entry.host}
            {entry.count > 1 ? ` ×${entry.count}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

export function DiffView({ diff }: { diff: string }) {
  return (
    <pre>
      {diff.split("\n").map((line, index) => (
        <div
          key={index}
          className={
            line.startsWith("+") && !line.startsWith("+++") ? "diff-add" : line.startsWith("-") && !line.startsWith("---") ? "diff-del" : line.startsWith("@@") ? "diff-hunk" : ""
          }
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}
