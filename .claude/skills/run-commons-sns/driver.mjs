#!/usr/bin/env node
// Headless driver for commons-sns.
//
// Drives the *running* dev server (react-router dev + workerd + local D1)
// with Playwright's pre-installed Chromium. It never touches the remote
// Cloudflare D1 — everything runs against the local Miniflare database, so
// it is safe against the deployed production instance.
//
// Prereqs (see SKILL.md): `npm run db:migrate:local` once, then
// `npm run dev` running in the background on http://localhost:5173.
//
// Usage:
//   node .claude/skills/run-commons-sns/driver.mjs smoke   # signup + post + screenshots (default)
//   node .claude/skills/run-commons-sns/driver.mjs shot /users/commons_dev out.png
//
// Env:
//   COMMONS_BASE_URL     base URL of the running dev server (default http://localhost:5173)
//   COMMONS_SHOTS        screenshot output dir (default /tmp/commons-shots)
//   COMMONS_ALLOW_REMOTE set to 1 to let the mutating `smoke` flow run against a
//                        non-local origin (off by default — see the guard below)
// Sequential browser steps (nav → wait → click → screenshot) each depend on
// the previous, so awaiting inside loops is intended here — the same reason
// .oxlintrc.json turns this rule off for e2e/**.
/* eslint-disable no-await-in-loop */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = (process.env.COMMONS_BASE_URL ?? "http://localhost:5173").replace(/\/$/, "");
const SHOTS = process.env.COMMONS_SHOTS ?? "/tmp/commons-shots";
// Symlink Playwright drops for the container's pre-installed browser; used as
// a fallback if the bundled build number doesn't match this playwright-core.
const CHROMIUM = "/opt/pw-browsers/chromium";

mkdirSync(SHOTS, { recursive: true });

// The dev-only timeline auto-reload polls every 2s and keeps the network from
// ever going idle. Disabling it per-nav makes waits deterministic and keeps
// screenshots from flickering mid-revalidation.
function url(path) {
  const u = new URL(path, BASE);
  if (!u.searchParams.has("autoReloadMs")) u.searchParams.set("autoReloadMs", "0");
  return u.toString();
}

// `smoke` performs real writes (signup + a post). Refuse to run it against a
// non-local origin so a stray COMMONS_BASE_URL can never mutate the deployed
// instance's data. `shot` is read-only and is not gated.
function isLoopbackHost(host) {
  const h = host.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1";
}

function mutationsAllowed() {
  return isLoopbackHost(new URL(BASE).hostname) || process.env.COMMONS_ALLOW_REMOTE === "1";
}

// Cold-start Vite dep pre-bundling logs these on the very first load; they are
// benign and gone on warm runs. Everything else is a real error that fails.
function isColdStartNoise(text) {
  return /Outdated Optimize Dep/i.test(text) || /Failed to fetch dynamically imported module/i.test(text);
}

async function launch() {
  const opts = { args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] };
  try {
    return await chromium.launch(opts);
  } catch {
    return await chromium.launch({ ...opts, executablePath: CHROMIUM });
  }
}

function uniqueUser() {
  const handle = `drv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.slice(0, 20);
  return { handle, displayName: `Driver ${handle.slice(-4)}`, password: "driver-password-123" };
}

// The first click after a load can beat React hydration: the SSR button is
// visible before its handler is wired. Retry until the effect is observable.
async function clickExpecting(page, trigger, expected, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (!(await expected.isVisible().catch(() => false))) {
      await trigger.click({ timeout: 2_000 }).catch(() => {});
    }
    if (await expected.isVisible({ timeout: 1_500 }).catch(() => false)) return;
    if (Date.now() > deadline) throw new Error("clickExpecting: expected element never appeared");
  }
}

async function smoke(page) {
  const user = uniqueUser();

  // 1. Logged-out home.
  await page.goto(url("/"), { waitUntil: "networkidle" });
  await page.locator(".join-card").waitFor({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/01-home-loggedout.png`, fullPage: true });
  console.log("shot: 01-home-loggedout.png");

  // 2. Sign up through the modal.
  const dialog = page.getByRole("dialog");
  await clickExpecting(page, page.locator(".join-card").getByRole("button", { name: "アカウントを作成" }), dialog);
  await dialog.getByLabel("表示名").fill(user.displayName);
  await dialog.getByLabel("ユーザーID").fill(user.handle);
  await dialog.getByLabel("パスワード").fill(user.password);
  await dialog.getByRole("button", { name: "アカウントを作成" }).click();
  await page.locator(".account-switcher").filter({ hasText: user.displayName }).waitFor({ timeout: 15_000 });
  console.log(`signed up: @${user.handle}`);

  // Signup redirects to a bare "/", which re-enables the dev 2s auto-reload.
  // Reload through url() to restore ?autoReloadMs=0 before posting/screenshotting.
  await page.goto(url("/"), { waitUntil: "networkidle" });

  // 3. Post to the timeline.
  const body = `driver smoke ${new Date().toISOString()}`;
  const composer = page.locator("form.composer");
  await composer.getByPlaceholder("いまどうしてる？").fill(body);
  await composer.getByRole("button", { name: "投稿する" }).click();
  await page.locator("article.post").filter({ hasText: body }).waitFor({ timeout: 15_000 });
  console.log(`posted: ${body}`);

  // 4. Logged-in timeline with the new post.
  await page.screenshot({ path: `${SHOTS}/02-timeline-loggedin.png`, fullPage: true });
  console.log("shot: 02-timeline-loggedin.png");
}

async function shot(page, path, out) {
  await page.goto(url(path), { waitUntil: "networkidle" });
  await page.screenshot({ path: out, fullPage: true });
  console.log(`shot: ${out}`);
}

async function main() {
  const cmd = process.argv[2] ?? "smoke";

  if (cmd === "smoke" && !mutationsAllowed()) {
    console.error(
      `DRIVER FAILED: refusing to run the mutating smoke flow against non-local origin ${BASE}.\n` +
        `Point COMMONS_BASE_URL at localhost, or set COMMONS_ALLOW_REMOTE=1 to override.`,
    );
    process.exit(1);
  }

  const browser = await launch();
  const context = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  let failed = false;
  try {
    if (cmd === "shot") {
      await shot(page, process.argv[3] ?? "/", process.argv[4] ?? `${SHOTS}/shot.png`);
    } else if (cmd === "smoke") {
      await smoke(page);
    } else {
      throw new Error(`unknown command: ${cmd} (use "smoke" or "shot")`);
    }
  } catch (err) {
    failed = true;
    console.error(`\nDRIVER FAILED: ${err.message}`);
    await page.screenshot({ path: `${SHOTS}/error.png`, fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  const coldStart = errors.filter(isColdStartNoise);
  const real = errors.filter((e) => !isColdStartNoise(e));
  if (coldStart.length) console.log(`\nignored ${coldStart.length} cold-start Vite error(s)`);
  if (real.length) {
    console.error(`console errors (${real.length}):`);
    for (const e of real) console.error(`  - ${e}`);
  } else {
    console.log("console errors: none");
  }
  // Real browser errors fail the run even when the DOM flow completed, so CI /
  // agent smoke runs that gate on exit status don't treat them as a pass.
  process.exit(failed || real.length > 0 ? 1 : 0);
}

await main();
