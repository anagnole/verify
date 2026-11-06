import { useState } from "react";
import type { Overview } from "./api";

const expectTone: Record<string, { pill: string; text: string }> = {
  pass: { pill: "pass", text: "should pass" },
  fail: { pill: "warn", text: "bug planted" },
  blocked: { pill: "fail", text: "containment: network" },
  memory: { pill: "fail", text: "containment: memory" },
};

export default function TryPage({ overview }: { overview: Overview | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [android, setAndroid] = useState(false);

  async function start(id: string) {
    setBusy(id);
    setError(null);
    try {
      const response = await fetch(`/api/try/${id}${android ? "?android=1" : ""}`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not start");
      window.location.hash = `#/jobs/${body.id}`;
    } catch (failure: any) {
      setError(failure.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <section className="hero">
        <div>
          <h1>Pretend you are the coding agent.</h1>
          <p>
            Each card is a change an agent made to a small packing list app (Expo, runs on web and Android). Press Verify and watch an independent agent
            prove it works, or catch it, inside a sandbox on Vultr. Each run takes about a minute.
          </p>
        </div>
      </section>
      <label className="android-toggle">
        <input type="checkbox" checked={android} onChange={(event) => setAndroid(event.target.checked)} />
        <span>
          Also on the Android emulator <span className="muted">(runs after web passes, about 3 more minutes)</span>
        </span>
      </label>
      {error && (
        <div className="verdict-banner unverified" style={{ marginBottom: 16 }}>
          <div className="icon">!</div>
          <div className="text">{error}</div>
        </div>
      )}
      <div className="try-grid">
        {(overview?.changes ?? []).map((change) => {
          const tone = expectTone[change.expect] ?? expectTone.pass;
          return (
            <div key={change.id} className="try-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <h3>{change.title}</h3>
                <span className={`pill ${tone.pill}`}>{tone.text}</span>
              </div>
              <div className="agent-says">The agent says: “{change.message}”</div>
              <div className="blurb">{change.blurb}</div>
              <div className="actions">
                <span className="chip">try/{change.id}</span>
                <button className="button primary" disabled={!!busy} onClick={() => start(change.id)}>
                  {busy === change.id ? "Starting…" : "Verify"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
