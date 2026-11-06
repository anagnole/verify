export default function HowPage() {
  return (
    <>
      <section className="hero">
        <div>
          <h1>Proof, not promises.</h1>
          <p>
            Coding agents say "done" when the code compiles. verify makes them show it working: the agent hands its change over, and a second agent that
            it can't influence tests it in a disposable sandbox and sends back evidence.
          </p>
        </div>
      </section>
      <div className="steps-strip">
        <div>
          <div className="n">1</div>
          <div className="t">The agent runs verify</div>
          <div className="d">Its last step. The CLI uploads the working tree, never .env files, and waits.</div>
        </div>
        <div>
          <div className="n">2</div>
          <div className="t">A queue picks a sandbox</div>
          <div className="d">Waiting agents first, cheap checks first. Packed by CPU and memory across Vultr workers.</div>
        </div>
        <div>
          <div className="n">3</div>
          <div className="t">An independent agent tests it</div>
          <div className="d">It reads the diff and the screen, writes its own scenario with edge cases, and drives the app in a browser or an Android emulator.</div>
        </div>
        <div>
          <div className="n">4</div>
          <div className="t">Proof comes back</div>
          <div className="d">Pass or fail with screenshots, a recording, network and memory numbers. Then the sandbox is destroyed.</div>
        </div>
      </div>

      <section className="anything">
        <h2 className="section-title">Verify anything that runs</h2>
        <p className="anything-lead">
          Any repo works the same way. The coding agent writes a short <code>verify.yml</code> once: how to install the app, start it and reach it. From then
          on the verifier reads each diff and decides what to check.
        </p>
        <div className="platforms">
          <div>
            <div className="t">Web</div>
            <div className="row">
              <span className="when now">Now</span>
              <span>Any app with a dev server: Vite, Next.js, Create React App, static sites, Expo web. Driven in Chromium by Playwright.</span>
            </div>
            <div className="row">
              <span className="when later">Later</span>
              <span>Firefox and WebKit. Lighthouse and accessibility scores.</span>
            </div>
          </div>
          <div>
            <div className="t">Mobile</div>
            <div className="row">
              <span className="when now">Now</span>
              <span>Expo and React Native on an Android 14 emulator inside the sandbox, driven by Maestro.</span>
            </div>
            <div className="row">
              <span className="when later">Later</span>
              <span>Several Android versions side by side. iOS on Mac workers.</span>
            </div>
          </div>
          <div>
            <div className="t">Other</div>
            <div className="row">
              <span className="when later">Later</span>
              <span>Backend and API checks. Database migrations on a throwaway copy. Command-line tools, with a terminal recording. Proof posted on the pull request.</span>
            </div>
          </div>
        </div>
      </section>

      <div className="grid-2">
        <section>
          <h2 className="section-title">In the agent's terminal</h2>
          <div className="terminal">{`$ verify "Added a delete button to each item"
verify job 4f1c2a · 412 KB uploaded
web        Warm start: saved image for this repo and lockfile
web        App is up at http://localhost:8081
web        Planning the scenario from the diff and the screen
web        Running the test scenario
web        Judging the screenshots against the checks

FAIL  Added a delete button to each item
  web FAIL Deleting "Phone charger" removed "Sunglasses" instead.
    ✗ Tap delete on Phone charger → Phone charger disappears
    Bug: Delete removes the item below the one tapped
      1. Open the list  2. Tap ✕ next to Phone charger

Proof: https://verify…/#/jobs/4f1c2a`}</div>
          <h2 className="section-title" style={{ marginTop: 24 }}>
            Set up a repo
          </h2>
          <div className="terminal">{`# verify.yml in the repo root (the coding agent writes it when asked)
install: npm install
start: npx expo start --web --port 8081
ready: http://localhost:8081
platforms: [web]
allow: []

# once per machine
verify login https://your-verify-server <token>`}</div>
        </section>
        <aside>
          <h2 className="section-title">Built on Vultr</h2>
          <div className="panel panel-pad">
            <p style={{ marginTop: 0 }}>
              <b>Control VM</b> (Vultr Cloud Compute): web app, queue, verifier agent. The only place that holds keys.
            </p>
            <p>
              <b>Worker VMs</b> (Vultr VX1, with KVM for the Android emulator): run the sandboxes. Created from a snapshot and destroyed through the Vultr API as the queue grows and shrinks.
            </p>
            <p>
              <b>Vultr Serverless Inference</b>: plans the scenario, writes and repairs the test script, and judges the screenshots.
            </p>
            <p style={{ marginBottom: 0 }}>
              <b>Every sandbox</b>: capped CPU and memory, all Linux capabilities dropped, no secrets, a private network whose only exit is a proxy that
              allows the package registry during install and nothing after. Destroyed after each run.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
