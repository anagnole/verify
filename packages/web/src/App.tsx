import { useEffect, useState } from "react";
import { getJson, useRefreshing } from "./api";
import type { Overview as OverviewData } from "./api";
import Overview from "./Overview";
import JobPage from "./JobPage";
import TryPage from "./TryPage";
import HowPage from "./HowPage";

function useHash() {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash || "#/");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHash();
  const [overview] = useRefreshing<OverviewData>(
    () => getJson("/api/state"),
    (message) => message.type === "job" || message.type === "workers" || message.type === "run",
  );
  const jobMatch = hash.match(/^#\/jobs\/([a-z0-9]+)/);
  const page = jobMatch ? "job" : hash.startsWith("#/try") ? "try" : hash.startsWith("#/how") ? "how" : "live";
  const models = overview?.models;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a href="#/" className="brand">
            <img src="/favicon.svg" alt="" />
            verify
          </a>
          <nav className="nav">
            <a href="#/" className={page === "live" ? "active" : ""}>
              Live
            </a>
            <a href="#/try" className={page === "try" ? "active" : ""}>
              Try it
            </a>
            <a href="#/how" className={page === "how" ? "active" : ""}>
              How
            </a>
          </nav>
          <div className="spacer" />
          <div className="powered">
            <span className={`dot ${overview?.workers.length ? "" : "off"}`} />
            <span className="long">
              {models ? (models.offline ? "Offline model stand-in" : `Vultr Serverless Inference · ${models.text}`) : "connecting"}
            </span>
          </div>
        </div>
      </header>
      <main className="shell">
        {page === "job" && jobMatch && <JobPage key={jobMatch[1]} id={jobMatch[1]} />}
        {page === "try" && <TryPage overview={overview} />}
        {page === "how" && <HowPage />}
        {page === "live" && <Overview data={overview} />}
      </main>
    </>
  );
}
