---
name: inspect-commons-sns
description: Render commons-sns routes and drive its write flows without a browser or workerd, by running the built server bundle under plain Node against an in-memory SQLite stand-in for D1. Use when the dev server or Playwright cannot run (Termux/PRoot, arm64, containers with no Chromium), or for a fast check that a route still server-renders correctly.
---

commons-sns normally runs on workerd (Miniflare) and is driven with Playwright — see the `run-commons-sns` skill, which is the better tool whenever it works. It needs two native binaries, `workerd` and Chromium, and on some platforms neither runs: on Termux/PRoot (Android, arm64) `npm run dev` hangs during Vite's dep pre-bundling and never serves, and no Playwright browser exists.

This skill covers that gap. It imports the **production server bundle** directly into Node and calls its `fetch` handler, with an in-memory SQLite database standing in for D1. There is no dev server, no workerd, and no browser.

All paths below are relative to the repo root (`commons-sns/`).

## What it can and cannot tell you

| Question | This skill | `run-commons-sns` |
|---|---|---|
| Does the route server-render? Correct markup, classes, text? | yes | yes |
| Do loaders/actions and the SQL behind them work? | yes | yes |
| Does it look right — layout, spacing, CSS, responsive? | **no** | yes |
| Client-side behaviour after hydration | **no** | yes |
| Screenshots | **no** | yes |

Treat a pass here as "the server is producing the right HTML", never as "the UI looks right". For anything visual, a screenshot from `run-commons-sns` or a reviewer with a browser is still required.

> **It cannot reach any real database.** The database is created in memory from `migrations/` on every run and thrown away at exit. There is no wrangler, no `--remote`, no network — so unlike a dev-server-based tool, there is no configuration under which this touches deployed data.

## Setup

Node 22.13+ or 23.4+ — `node:sqlite` exists from 22.5 but needs `--experimental-sqlite` before those releases. Build the bundle this runs against — re-run after any app change:

```bash
npm install --ignore-scripts   # the postinstall `wrangler types` hangs where workerd cannot run
npm run build
```

## Drive a flow

Signs up a fresh user, posts, updates a profile, and reads each write back from every surface that shows it:

```bash
node .claude/skills/inspect-commons-sns/inspect.mjs flow
```

```text
ok   ゲストのタイムラインが描画される — status 200
ok   シードされた投稿が並ぶ — 4件
...
17/17 passed
```

Each line is a separate assertion; the command exits non-zero if any fail, so it can gate a change. A broken avatar branch, a loader that throws, a 500 on save — all surface here.

## Render one route

```bash
node .claude/skills/inspect-commons-sns/inspect.mjs render /users/aoi_note --out /tmp/profile.html
node .claude/skills/inspect-commons-sns/inspect.mjs render / --login          # signs up first, renders as that user
node .claude/skills/inspect-commons-sns/inspect.mjs render /bookmarks --login
```

Without `--out` the HTML goes to stdout. Grep it to check your change landed:

```bash
node .claude/skills/inspect-commons-sns/inspect.mjs render / --out /tmp/home.html
grep -o 'class="post-identity-link"' /tmp/home.html | head
```

`render` exits non-zero on a 4xx/5xx, so it doubles as a smoke check for a single route.

## How it works

`d1-sqlite.mjs` maps the slice of the D1 API the app uses (`prepare` / `bind` / `first` / `all` / `run` / `batch`) onto `node:sqlite`, applying every file in `migrations/` in filename order — the same order wrangler uses. `inspect.mjs` imports `build/server/index.js`, calls its `fetch` handler with that database as `env.DB`, and keeps a cookie jar so sessions work across requests.

Because the schema comes from the real migrations and the code from the real bundle, a schema/query mismatch fails here the same way it would in production.

## Limits worth knowing

- **The bundle is a build artifact.** Stale results mean you forgot `npm run build`.
- **Actions on the index route need `?index`** (`POST /?index`), as React Router requires — already handled inside the skill, but relevant if you add flows.
- **SQLite is not D1.** They agree on the SQL this app writes, but they are different engines; a D1-specific behaviour difference would not show up here. CI remains the authority.
- **No client-side JavaScript runs.** Anything rendered only after hydration is invisible to this tool.
