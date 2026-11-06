import { ago, artifactUrl, useTick } from "./api";
import type { Overview as OverviewData, WorkerView } from "./api";
import { StatusPill, TargetPill } from "./ui";

function Workers({ workers, pending }: { workers: WorkerView[]; pending: { label: string; since: number }[] }) {
  return (
    <div className="panel">
      <div className="panel-title">
        Fleet
        <span className="spacer" />
        <span className="hint">Vultr VMs running sandboxes</span>
      </div>
      {workers.length === 0 && pending.length === 0 && <div className="empty-note">No workers connected.</div>}
      {workers.map((worker) => (
        <div key={worker.id} className="worker">
          <div className="worker-head">
            <span className="dot" />
            <span className="worker-name">{worker.name}</span>
            {worker.autoscaled && <span className="pill running">autoscaled</span>}
            <span className="spacer" />
            {worker.region && <span className="chip">{worker.region}</span>}
            <span className="chip">web</span>
            {worker.android && <span className="chip">Android 14</span>}
          </div>
          <div className="bar-row">
            <span>CPU</span>
            <div className="bar">
              <div style={{ width: `${Math.min(100, (worker.usedCpus / Math.max(1, worker.cpus)) * 100)}%` }} />
            </div>
            <span className="num">
              {worker.usedCpus}/{worker.cpus} cores
            </span>
          </div>
          <div className="bar-row">
            <span>Memory</span>
            <div className="bar">
              <div style={{ width: `${Math.min(100, (worker.usedMemoryMb / Math.max(1, worker.memoryMb)) * 100)}%` }} />
            </div>
            <span className="num">
              {(worker.usedMemoryMb / 1024).toFixed(1)}/{(worker.memoryMb / 1024).toFixed(1)} GB
            </span>
          </div>
          <div className="slots">
            {worker.active.length === 0 && <span className="muted" style={{ fontSize: 12 }}>idle · {worker.images} warm image{worker.images === 1 ? "" : "s"}</span>}
            {worker.active.map((runId) => (
              <span key={runId} className="slot">
                <span className="spin" /> sandbox {runId.slice(0, 6)}
              </span>
            ))}
          </div>
        </div>
      ))}
      {pending.map((item) => (
        <div key={item.label} className="worker">
          <div className="worker-head">
            <span className="spin" style={{ color: "var(--run)" }} />
            {item.label}
            <span className="pill running">booting</span>
            <span className="spacer" />
            <span className="muted" style={{ fontSize: 12 }}>
              {ago(item.since)}
            </span>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Created through the Vultr API because the queue was waiting
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Overview({ data }: { data: OverviewData | null }) {
  useTick(5000);
  if (!data) return <div className="hero"><p className="muted">Loading…</p></div>;
  const running = data.jobs.filter((job) => job.status === "running" || job.status === "queued").length;
  const done = data.jobs.filter((job) => job.status === "done");
  const passed = done.filter((job) => job.verdict === "pass").length;
  const failed = done.filter((job) => job.verdict === "fail").length;
  const cores = data.workers.reduce((sum, worker) => sum + worker.cpus, 0);

  return (
    <>
      <section className="hero">
        <div>
          <h1>
            Coding agents don't get to say done. <em>They prove it.</em>
          </h1>
          <p>
            When an agent finishes, it runs <span className="chip">verify</span>. An independent agent tests the change in a throwaway sandbox on Vultr
            and sends back screenshots, video and numbers.
          </p>
        </div>
        <a className="button primary" href="#/try">
          Try it on a demo app →
        </a>
      </section>

      <div className="stats">
        <div className="stat">
          <div className="label">Workers</div>
          <div className="value">{data.workers.length}</div>
          <div className="sub">{cores} cores in the fleet</div>
        </div>
        <div className="stat">
          <div className="label">In progress</div>
          <div className="value">{running}</div>
          <div className="sub">{data.queued.length} waiting in line</div>
        </div>
        <div className="stat">
          <div className="label">Proven working</div>
          <div className="value" style={{ color: "var(--pass)" }}>
            {passed}
          </div>
          <div className="sub">of the last {done.length}</div>
        </div>
        <div className="stat">
          <div className="label">Caught before "done"</div>
          <div className="value" style={{ color: "var(--fail)" }}>
            {failed}
          </div>
          <div className="sub">bugs, leaks and blocked calls</div>
        </div>
      </div>

      <div className="grid-2">
        <section>
          <h2 className="section-title">Verifications</h2>
          <div className="jobs">
            {data.jobs.length === 0 && <div className="panel empty-note">Nothing yet. Run verify from a repo, or use Try it.</div>}
            {data.jobs.map((job) => {
              const thumbRun = job.runs.find((run) => run.thumb);
              return (
                <a key={job.id} href={`#/jobs/${job.id}`} className="job">
                  {thumbRun ? <img className="thumb" src={artifactUrl(thumbRun.id, thumbRun.thumb!)} alt="" loading="lazy" /> : <div className="thumb empty">…</div>}
                  <div style={{ minWidth: 0 }}>
                    <div className="message">{job.message}</div>
                    <div className="meta">
                      <span>{job.repo}</span>
                      <span className="chip">{job.branch}</span>
                      <span>{job.agent}</span>
                      <span>{ago(job.createdAt)}</span>
                    </div>
                    {job.summary && <div className="summary">{job.summary}</div>}
                  </div>
                  <div className="targets">
                    <StatusPill item={job} />
                    {job.runs.length > 1 && job.runs.map((run) => <TargetPill key={run.id} run={run} />)}
                  </div>
                </a>
              );
            })}
          </div>
        </section>
        <aside>
          <h2 className="section-title">Fleet and queue</h2>
          <Workers workers={data.workers} pending={data.autoscale.pending} />
          <div className="panel">
            <div className="panel-title">
              Queue
              <span className="spacer" />
              <span className="hint">waiting agents first, cheap checks first</span>
            </div>
            {data.queued.length === 0 && <div className="empty-note">Nobody waiting.</div>}
            {data.queued.map((item, index) => (
              <a key={item.id} href={`#/jobs/${item.jobId}`} className="queue-item">
                <span className="pos">{index + 1}</span>
                <span className="text">{item.message}</span>
                <span className="chip">{item.target}</span>
              </a>
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}
