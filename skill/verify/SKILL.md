---
name: verify
description: Verify a change end to end before saying it's done. Works out how the project runs, writes its verify.yml, and runs the verify service, which starts the app in a sandbox, has an independent agent test the change and returns screenshots and a verdict. Use it when you finish a change to a web or Expo app, or when the user asks you to verify, test or prove a change.
---

# Verify

The verify service starts the app in a throwaway sandbox on Vultr, has an independent agent test your change, and sends back screenshots, a recording, network and memory facts, and a verdict. The command is `verify` (install it from this repo with `npm install -g ./packages/cli`, then `verify login <server> <token>`).

## 1. Can the service run this project?

It can when the app starts with one command and works without secrets: web front ends (Vite, Next.js, CRA, plain static), Expo apps on the web, and Expo apps on Android when a debug APK exists.

It can't when the app needs a login, a private backend, secrets, iOS, or a native change that needs a new APK. Then say so in one line and verify with the repo's own tests or guide instead.

## 2. Write verify.yml (once per repo)

Work it out from `package.json` scripts, the framework config (`vite.config`, `next.config`, `app.json`) and the README, then write `verify.yml` at the repo root:

```yaml
install: npm install --no-audit --no-fund
start: npm run dev -- --port 5173 --host 127.0.0.1
ready: http://localhost:5173
platforms: [web]
allow: []
```

- `install` matches the lockfile: `yarn install`, `pnpm install` or `npm install`.
- `start` runs the dev server in the foreground on an explicit port, without opening a browser or asking anything.
- `ready` is a URL that answers once the app is up.
- `allow` lists hosts the app must reach while it runs (a public API). Everything else is blocked.
- Expo: `start: npx expo start --web --port 8081`, `ready: http://localhost:8081`. For Android also add `android-34` to `platforms`, `android_apk` (URL of a debug build), `android_package`, and `android_start: npx expo start --port 8081`. Look for the debug build in the README, `eas.json` or the docs; without one, verify the web only.
- Never put secrets in it. It is uploaded and usually committed.

Leave `verify.yml` uncommitted for the user to review unless they asked you to commit.

## 3. Run it

```bash
verify "<what you changed>, <what should now be true>"
verify "<...>" --on web,android-34
```

Write the message like a ticket: the behaviour, not the code ("Added a delete button to each item; tapping it removes that item"). The verifier reads your diff and writes its own checks. It doesn't take your word for anything.

The command uploads the working tree (never `.env` files), waits in the queue, prints each stage, and ends with a verdict and a proof link. Exit code 0 is pass, 1 fail, 2 couldn't verify. A run takes about a minute on web and a few minutes on Android, so give the command a 10-minute timeout. Android waits for web to pass: if web fails, Android is skipped until the web failure is fixed.

## 4. Act on the result

- **FAIL:** the report says what actually happened ("tapping delete on Sunglasses removed Swimsuit") and how to reproduce it. Fix the code and run `verify` again. If you think the verifier is wrong, open the proof link and look at the screenshots before saying so.
- **COULDN'T VERIFY:** usually the recipe. Read the reason (install failed, the app didn't start, wrong port), fix `verify.yml`, run again. If the sandbox can't provide what the app needs, say that.
- **Blocked network or memory cap:** treat these as real findings. A dependency that calls out during install, or a page killed at the memory cap, fails the change.

## 5. Report

One line per platform, then the proof link. Never claim a platform you didn't verify; if one didn't run, say why in a few words.

```
web: PASS, 5 checks
android-34: PASS, 4 checks
Proof: https://…/#/jobs/…
```
