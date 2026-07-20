---
name: run-commons-sns
description: Build, run, and drive the commons-sns app (React Router + Cloudflare Workers + local D1). Use when asked to start the dev server, launch or run commons-sns, take a screenshot of the timeline/profile UI, drive a signup/post flow, or run its unit/e2e tests.
---

commons-sns is a server-rendered SNS: React Router 8 on Cloudflare Workers, with D1 (SQLite) for data. Locally it runs entirely on Miniflare/workerd against a **local** D1 database — it never talks to the deployed Cloudflare instance. An agent drives the *running* dev server with `.claude/skills/run-commons-sns/driver.mjs`, a Playwright script that uses the container's pre-installed Chromium to sign up, post, and screenshot.

All paths below are relative to the repo root (`commons-sns/`).

> **Never touch the deployed instance's data.** This app runs on Cloudflare with a production D1 that holds real data. Everything here uses only the **local** D1 (Miniflare). Do **not** run `db:migrate:remote`, `wrangler deploy`, `wrangler d1 execute --remote`, or `npm run deploy`. As a backstop, the driver's `smoke` flow (which writes) refuses any non-loopback `COMMONS_BASE_URL` unless `COMMONS_ALLOW_REMOTE=1` is set.

## Prerequisites

No OS packages needed in this environment: Node 22 is present and Chromium is pre-installed for Playwright at `/opt/pw-browsers/` (`PLAYWRIGHT_BROWSERS_PATH` is set). Do **not** run `playwright install`.

```bash
node --version   # v22.x — the app requires Node 22+
```

## Setup

Install deps and apply migrations to the **local** D1 (creates `.wrangler/state/v3/d1`, git-ignored; seeds 4 users + 4 posts):

```bash
npm install
WRANGLER_SEND_METRICS=false npm run db:migrate:local
```

## Run (agent path)

Start the dev server in the background and wait for it to actually serve (Vite compiles on demand — poll, don't sleep):

```bash
npm run dev > /tmp/commons-dev.log 2>&1 &
timeout 90 bash -c 'until curl -sf http://localhost:5173/api/health >/dev/null; do sleep 1; done'
curl -s http://localhost:5173/api/health   # {"ok":true,...,"database":"connected"}
```

Then drive it. The driver signs up a fresh user, posts to the timeline, and writes two screenshots:

```bash
node .claude/skills/run-commons-sns/driver.mjs smoke
```

Screenshots land in `/tmp/commons-shots/` (override with `COMMONS_SHOTS`):

| file | what it shows |
|---|---|
| `01-home-loggedout.png` | logged-out 3-column timeline + join card |
| `02-timeline-loggedin.png` | logged-in timeline with the freshly posted card |
| `error.png` | written only if the flow throws |

Screenshot any route without the signup flow:

```bash
node .claude/skills/run-commons-sns/driver.mjs shot /users/commons_dev /tmp/commons-shots/profile.png
```

The driver filters known cold-start Vite 504s, prints any remaining console/page errors, and exits non-zero if the flow fails **or** a real browser error occurred — so a CI/agent run that gates on exit status won't treat a broken page as a pass. Stop the dev server with:

```bash
pkill -f 'react-router dev'
```

### Driver commands

| command | what it does |
|---|---|
| `smoke` (default) | signup → post → 2 screenshots; checks console errors |
| `shot <path> <out.png>` | full-page screenshot of one route |

Env: `COMMONS_BASE_URL` (default `http://localhost:5173`), `COMMONS_SHOTS` (default `/tmp/commons-shots`), `COMMONS_ALLOW_REMOTE=1` (opt out of the `smoke` local-origin guard — only if you really mean to write to a non-local origin).

## Run (human path)

`npm run dev` opens a dev server at `http://localhost:5173`; open it in a browser, Ctrl-C to stop. Useless headless — an agent should use the driver above.

## Test

```bash
WRANGLER_SEND_METRICS=false npm test        # Vitest: 191 unit+integration tests (real Miniflare D1)
```

E2E runs Playwright against a dev server (auto-started, or reuses a running one). The default is 4 parallel workers, which flakes against one dev server + write-serialized local SQLite; run single-worker for a deterministic pass (this is what CI does):

```bash
npx playwright test --workers=1             # 36 e2e tests, ~2 min, deterministic
```

## Gotchas

- **First driver run hits three `504 (Outdated Optimize Dep)` errors.** Vite pre-bundles deps on the cold first load; the flow still completes and screenshots render. The driver recognizes these (and the follow-on "Failed to fetch dynamically imported module") as cold-start noise, reports `ignored N cold-start Vite error(s)`, and does **not** fail the run for them — only genuinely unexpected console/page errors set a non-zero exit. A warm re-run prints `console errors: none`.
- **Dev-only timeline auto-reload breaks `networkidle`.** The home timeline re-fetches every 2s in dev, so the network never idles and screenshots flicker mid-revalidation. The driver appends `?autoReloadMs=0` to every nav. Driving by hand? Do the same, or set `COMMONS_LOCAL_AUTO_RELOAD_MS=0` in `.dev.vars`.
- **React hydration race on the first click.** The SSR button paints before its handler attaches, so a `click()` right after load can no-op. The driver's `clickExpecting` retries the click until the dialog appears — mirror it for any first-interaction click.
- **E2E is flaky at the default 4 workers, green at `--workers=1`.** Not a product bug — parallel signups contend on the single local SQLite writer. CI uses 1 worker + 2 retries.
- **Chromium launch.** The driver calls `chromium.launch()` (finds `/opt/pw-browsers`) and falls back to `executablePath: /opt/pw-browsers/chromium` if the build number mismatches. Never `playwright install`.

## Troubleshooting

- **`EADDRINUSE` / port 5173 busy**: a dev server is already up. Reuse it, or `pkill -f 'react-router dev'` and relaunch.
- **`DRIVER FAILED: ... expected element never appeared`**: the dev server wasn't ready (first compile is slow). Confirm `curl -s http://localhost:5173/api/health` returns `"ok":true` before running the driver.
- **health shows `"database":"not-configured"`**: local D1 isn't migrated. Run `WRANGLER_SEND_METRICS=false npm run db:migrate:local`.
