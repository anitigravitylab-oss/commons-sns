#!/usr/bin/env node
// Browserless inspector for commons-sns.
//
// Runs the production server bundle directly under Node, against an in-memory
// SQLite database standing in for D1. No workerd, no browser, no dev server —
// which makes it the only way to exercise the app on platforms where those
// native binaries cannot run (Termux/PRoot on Android, for one).
//
// What it gives you is the server-rendered HTML and the data flow behind it.
// What it cannot give you is layout, CSS, or anything the client bundle does
// after hydration — use `run-commons-sns` (Playwright) when you need those.
//
// Prereq: `npm run build` (the bundle under build/server/ is what runs here).
//
// Usage:
//   node .claude/skills/inspect-commons-sns/inspect.mjs render /
//   node .claude/skills/inspect-commons-sns/inspect.mjs render / --login --out /tmp/home.html
//   node .claude/skills/inspect-commons-sns/inspect.mjs flow
//
// Sequential steps (sign up → post → read back) each depend on the previous,
// so awaiting inside loops is intended here — the same reason .oxlintrc.json
// turns this rule off for e2e/**.
/* eslint-disable no-await-in-loop */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSqliteD1 } from "./d1-sqlite.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_BUNDLE = resolve(REPO_ROOT, "build/server/index.js");
const MIGRATIONS = resolve(REPO_ROOT, "migrations");
// Any origin works — nothing leaves this process — but the app builds absolute
// URLs from it, so keep it loopback-shaped for readable output.
const ORIGIN = "http://localhost";

/** A cookie-jar-carrying client that speaks to the bundle's fetch handler. */
function createClient(handler, env) {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const cookies = new Map();

  return {
    get cookieHeader() {
      return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    async request(path, { method = "GET", form } = {}) {
      const headers = {};
      const jar = this.cookieHeader;
      if (jar) headers.cookie = jar;

      let body;
      if (form) {
        body = new URLSearchParams(form);
        headers["content-type"] = "application/x-www-form-urlencoded";
      }

      const response = await handler.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), env, ctx);

      // Sessions ride on Set-Cookie; keep them so later requests are authenticated.
      for (const cookie of response.headers.getSetCookie?.() ?? []) {
        const [pair] = cookie.split(";");
        const index = pair.indexOf("=");
        if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
      return response;
    },
  };
}

async function loadHandler() {
  if (!existsSync(SERVER_BUNDLE)) {
    throw new Error(`server bundle not found at ${SERVER_BUNDLE}\nRun \`npm run build\` first.`);
  }
  const module = await import(pathToFileURL(SERVER_BUNDLE).href);
  return module.default;
}

/**
 * One database, one handler, and a factory for clients over them. Separate
 * clients share the data but not the cookie jar, which is what lets a flow
 * check that logging in actually establishes a session rather than inheriting
 * the one signup already created.
 */
async function setup() {
  const db = createSqliteD1(MIGRATIONS);
  const handler = await loadHandler();
  const env = { DB: db };
  const newClient = () => createClient(handler, env);
  return { client: newClient(), newClient, db };
}

function uniqueUser() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  return {
    handle: `ins_${suffix}`.slice(0, 20),
    displayName: `検証 ${suffix.slice(-4)}`,
    password: "inspect-password-123",
  };
}

/** Signs up a fresh account; the client keeps the session from here on. */
async function signUp(client, user = uniqueUser()) {
  const response = await client.request("/?index", {
    method: "POST",
    form: { intent: "signup", displayName: user.displayName, handle: user.handle, password: user.password },
  });
  if (response.status !== 302) {
    throw new Error(`signup failed: expected a redirect, got ${response.status}\n${await response.text()}`);
  }
  return user;
}

/** Logs an existing account in on whichever client is passed. */
async function logIn(client, user) {
  return client.request("/?index", {
    method: "POST",
    form: { intent: "login", handle: user.handle, password: user.password },
  });
}

async function render(path, { login, out }) {
  const { client, db } = await setup();
  console.log(`migrations: ${db.appliedMigrations.join(", ")}`);

  let user;
  if (login) {
    user = await signUp(client);
    console.log(`signed up: @${user.handle}`);
  }

  const response = await client.request(path);
  const html = await response.text();
  console.log(`GET ${path} → ${response.status} (${html.length} bytes)`);

  if (out) {
    writeFileSync(out, html);
    console.log(`written: ${out}`);
  } else {
    console.log(html);
  }
  // A 4xx/5xx is a real failure; the caller should be able to gate on it.
  return response.ok;
}

/**
 * Exercises the paths that a screenshot would otherwise be checked against:
 * that pages render, that writes land, and that they read back everywhere the
 * app shows them.
 */
async function flow() {
  const { client, newClient, db } = await setup();
  const checks = [];
  const check = (name, passed, detail = "") => {
    checks.push({ name, passed, detail });
    console.log(`${passed ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  console.log(`migrations: ${db.appliedMigrations.join(", ")}\n`);

  const guest = await client.request("/");
  const guestHtml = await guest.text();
  check(
    "ゲストのタイムラインが描画される",
    guest.status === 200 && guestHtml.includes("join-card"),
    `status ${guest.status}`,
  );
  const seeded = (guestHtml.match(/<article class="post/g) ?? []).length;
  check("シードされた投稿が並ぶ", seeded > 0, `${seeded}件`);

  const user = await signUp(client);
  check("サインアップしてセッションが張られる", Boolean(client.cookieHeader), `@${user.handle}`);

  const home = await client.request("/");
  const homeHtml = await home.text();
  check("ログイン後のタイムラインに自分が出る", homeHtml.includes(user.displayName));
  // 投稿フォームはログイン時だけ描かれ、ゲストには join-card が出る。
  // 「認証済みかどうか」を判定できる唯一の目印なので、緩い一致にはしない。
  check("投稿フォームが出る", homeHtml.includes('class="composer"') && !homeHtml.includes("join-card"));

  const body = `inspect flow ${new Date().toISOString()}`;
  const posted = await client.request("/?index", { method: "POST", form: { intent: "createPost", body } });
  check("投稿できる", posted.ok, `status ${posted.status}`);

  const afterPost = await client.request("/");
  check("投稿がタイムラインに出る", (await afterPost.text()).includes(body));

  const profile = await client.request(`/users/${user.handle}`);
  const profileHtml = await profile.text();
  check("プロフィールが描画される", profile.status === 200 && profileHtml.includes(user.displayName));
  check("プロフィールに投稿が出る", profileHtml.includes(body));

  const renamed = `${user.displayName}改`;
  const updated = await client.request(`/users/${user.handle}`, {
    method: "POST",
    form: { intent: "updateProfile", displayName: renamed, bio: "ハーネスからの自己紹介", avatarKey: "preset:clover" },
  });
  check("プロフィールを更新できる", updated.ok, `status ${updated.status}`);

  const afterUpdate = await client.request(`/users/${user.handle}`);
  const afterUpdateHtml = await afterUpdate.text();
  check("更新した表示名が反映される", afterUpdateHtml.includes(renamed));
  check("プリセットアイコンが描画される", afterUpdateHtml.includes("avatar-preset"));

  const missing = await client.request("/users/no_such_user_exists");
  check("存在しないユーザーは404", missing.status === 404, `status ${missing.status}`);

  // 別のクライアント（＝別のクッキージャー）でログインし直す。サインアップで
  // 得たセッションを使い回さないことで、ログイン自体の回帰を検出できる。
  const returning = newClient();
  const wrongPassword = await logIn(returning, { ...user, password: "definitely-wrong-password" });
  check("誤ったパスワードではログインできない", !returning.cookieHeader, `status ${wrongPassword.status}`);

  const loggedIn = await logIn(returning, user);
  check("既存アカウントでログインできる", loggedIn.status === 302 && Boolean(returning.cookieHeader));

  // 公開タイムラインは未ログインでも同じ投稿を返すため、投稿内容の一致だけでは
  // ログインの成否を判定できない。ログイン時のみ出る composer で確かめる。
  const asReturning = await returning.request("/");
  const asReturningHtml = await asReturning.text();
  check(
    "ログイン後のセッションが認証済みとして描画される",
    asReturningHtml.includes('class="composer"') && asReturningHtml.includes(renamed),
  );

  const loggedOut = newClient();
  check(
    "未ログインのクライアントは投稿できない",
    !(
      await loggedOut.request("/?index", {
        method: "POST",
        form: { intent: "createPost", body: "unauthenticated" },
      })
    ).ok,
  );

  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  return failed.length === 0;
}

/**
 * Parses `render` arguments strictly, so a misplaced flag fails loudly instead
 * of silently rendering the wrong route or writing nothing.
 *
 * @returns The `render` argument tuple: `[path, options]`.
 */
function parseRenderArgs(argv) {
  const options = { login: false, out: undefined };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--login") {
      options.login = true;
    } else if (arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--out requires a file path");
      options.out = value;
      i += 1; // consume the value so it is not read as the route
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) throw new Error(`expected one route, got ${positional.length}: ${positional.join(" ")}`);
  return [positional[0] ?? "/", options];
}

async function main() {
  const [command = "flow", ...rest] = process.argv.slice(2);

  let passed;
  if (command === "render") {
    passed = await render(...parseRenderArgs(rest));
  } else if (command === "flow") {
    passed = await flow();
  } else {
    throw new Error(`unknown command: ${command} (use "render" or "flow")`);
  }

  process.exit(passed ? 0 : 1);
}

try {
  await main();
} catch (error) {
  console.error(`INSPECT FAILED: ${error.message}`);
  process.exit(1);
}
