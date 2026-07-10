import type { AppEnv } from "../cloudflare";

const SESSION_COOKIE = "commons_session";
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 120_000;

export type SessionUser = {
  id: string;
  handle: string;
  displayName: string;
  role: "user" | "moderator" | "admin";
};

type AuthRow = {
  id: string;
  handle: string;
  display_name: string;
  role: SessionUser["role"];
  password_hash: string | null;
  password_salt: string | null;
};

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return bytesToHex(bytes);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function derivePassword(password: string, saltHex: string) {
  const salt = new Uint8Array(saltHex.match(/.{1,2}/g)?.map((part) => Number.parseInt(part, 16)) ?? []);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("Cookie") ?? "";
  for (const item of cookie.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function sessionCookie(token: string, maxAge: number) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export async function hashPassword(password: string) {
  const salt = randomToken(16);
  return { salt, hash: await derivePassword(password, salt) };
}

export async function verifyPassword(password: string, hash: string, salt: string) {
  return timingSafeEqual(await derivePassword(password, salt), hash);
}

export async function findUserForLogin(env: AppEnv, handle: string) {
  return env.DB.prepare(
    `SELECT id, handle, display_name, role, password_hash, password_salt
     FROM users WHERE handle = ? COLLATE NOCASE LIMIT 1`,
  ).bind(handle).first<AuthRow>();
}

export async function getSessionUser(request: Request, env: AppEnv): Promise<SessionUser | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const idHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.handle, u.display_name, u.role
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ? AND s.expires_at > datetime('now')
     LIMIT 1`,
  ).bind(idHash).first<Omit<AuthRow, "password_hash" | "password_salt">>();
  if (!row) return null;
  return { id: row.id, handle: row.handle, displayName: row.display_name, role: row.role };
}

export async function createSession(env: AppEnv, userId: string) {
  const token = randomToken();
  const idHash = await sha256(token);
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')"),
    env.DB.prepare("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(idHash, userId, expires),
  ]);
  return sessionCookie(token, SESSION_DAYS * 86_400);
}

export async function destroySession(request: Request, env: AppEnv) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(token)).run();
  return sessionCookie("", 0);
}
