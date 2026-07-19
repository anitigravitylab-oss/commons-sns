import { Miniflare } from "miniflare";
import type { AppEnv } from "../cloudflare";
import { hashPassword } from "../lib/auth.server";
// マイグレーションはファイル名順に全件を自動で取り込む。手書きリストだと
// マイグレーション追加時にテストだけ古いスキーマで走る事故が起こる。
const migrationModules = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const MIGRATIONS = Object.keys(migrationModules)
  .sort()
  .map((path) => migrationModules[path]);

/**
 * Splits a migration file into individual statements for D1's prepare API.
 *
 * The split is intentionally naive (none of our migrations embed `;` inside
 * string literals). `PRAGMA` lines are dropped: D1 enforces foreign keys by
 * default and rejects most PRAGMA statements.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0 && !/^PRAGMA\b/i.test(statement));
}

export type TestApp = {
  env: AppEnv;
  dispose: () => Promise<void>;
};

/**
 * Boots an in-memory D1 database inside workerd (via Miniflare) and applies
 * the real migrations, so tests run against genuine D1/SQLite semantics —
 * COLLATE NOCASE, CHECK constraints, ON CONFLICT clauses and result metadata
 * behave exactly like production.
 */
export async function createTestApp(): Promise<TestApp> {
  const mf = new Miniflare({
    modules: true,
    script: "export default { async fetch() { return new Response(null, { status: 404 }); } };",
    compatibilityDate: "2026-07-10",
    d1Databases: { DB: "commons-test-db" },
  });
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const migration of MIGRATIONS) {
    for (const statement of splitStatements(migration)) {
      await db.prepare(statement).run();
    }
  }
  return {
    env: { DB: db } as AppEnv,
    dispose: () => mf.dispose(),
  };
}

/** Removes every row (including the seed data) so each test starts clean. */
export async function resetData(env: AppEnv) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM post_reactions"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM follows"),
    env.DB.prepare("DELETE FROM media"),
    env.DB.prepare("DELETE FROM posts"),
    env.DB.prepare("DELETE FROM users"),
  ]);
}

let uniqueCounter = 0;
function nextId(prefix: string) {
  uniqueCounter += 1;
  return `${prefix}_${uniqueCounter.toString(36).padStart(4, "0")}`;
}

export type TestUser = {
  id: string;
  handle: string;
  displayName: string;
  password: string | null;
};

export async function createUser(
  env: AppEnv,
  options: {
    id?: string;
    handle?: string;
    displayName?: string;
    bio?: string;
    role?: "user" | "moderator" | "admin";
    password?: string | null;
    createdAt?: string;
  } = {},
): Promise<TestUser> {
  const id = options.id ?? nextId("user");
  const handle = options.handle ?? id;
  const displayName = options.displayName ?? `テスト ${id}`;
  const password = options.password === undefined ? "correct horse battery" : options.password;
  const credentials = password === null ? { hash: null, salt: null } : await hashPassword(password);
  await env.DB.prepare(
    `INSERT INTO users (id, handle, display_name, bio, role, password_hash, password_salt, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  )
    .bind(
      id,
      handle,
      displayName,
      options.bio ?? "",
      options.role ?? "user",
      credentials.hash,
      credentials.salt,
      options.createdAt ?? null,
    )
    .run();
  return { id, handle, displayName, password };
}

export async function createPost(
  env: AppEnv,
  options: {
    id?: string;
    authorId: string;
    body?: string;
    createdAt?: string;
    deletedAt?: string;
    visibility?: "public" | "followers";
    replyToId?: string;
  },
): Promise<{ id: string }> {
  const id = options.id ?? nextId("post");
  await env.DB.prepare(
    `INSERT INTO posts (id, author_id, body, reply_to_id, visibility, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?)`,
  )
    .bind(
      id,
      options.authorId,
      options.body ?? `本文 ${id}`,
      options.replyToId ?? null,
      options.visibility ?? "public",
      options.createdAt ?? null,
      options.deletedAt ?? null,
    )
    .run();
  return { id };
}

export async function addReaction(
  env: AppEnv,
  options: { userId: string; postId: string; kind: "like" | "repost" | "bookmark"; createdAt?: string },
) {
  await env.DB.prepare(
    `INSERT INTO post_reactions (user_id, post_id, kind, created_at)
     VALUES (?, ?, ?, COALESCE(?, datetime('now')))`,
  )
    .bind(options.userId, options.postId, options.kind, options.createdAt ?? null)
    .run();
}

export async function addFollow(env: AppEnv, followerId: string, followingId: string) {
  await env.DB.prepare("INSERT INTO follows (follower_id, following_id) VALUES (?, ?)")
    .bind(followerId, followingId)
    .run();
}

/**
 * Wraps an env so statements whose SQL contains `match` reject when executed
 * (like a real D1 failure), while every other statement keeps hitting the
 * real database. Used to exercise the degraded paths — loaders and actions
 * that must survive a failing query.
 */
export function failingEnv(env: AppEnv, match: string, message = "simulated D1 failure"): AppEnv {
  const reject = () => Promise.reject(new Error(message));
  const failingStatement = {
    bind: () => failingStatement,
    run: reject,
    first: reject,
    all: reject,
    raw: reject,
  } as unknown as D1PreparedStatement;
  const prepare: AppEnv["DB"]["prepare"] = (sql: string) => {
    if (sql.includes(match)) return failingStatement;
    return env.DB.prepare(sql);
  };
  return { ...env, DB: { ...env.DB, prepare, batch: env.DB.batch.bind(env.DB) } as AppEnv["DB"] };
}

/** An env whose database rejects everything — the "D1 is down" scenario. */
export function brokenEnv(message = "simulated D1 outage"): AppEnv {
  return {
    DB: {
      prepare() {
        throw new Error(message);
      },
      batch() {
        throw new Error(message);
      },
    },
  } as unknown as AppEnv;
}
