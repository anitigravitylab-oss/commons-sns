import type { AppEnv } from "../cloudflare";

export const SESSION_COOKIE = "commons_session";
const SESSION_DAYS = 30;
// Cloudflare Workers rejects PBKDF2 iteration counts above 100,000.
const PBKDF2_ITERATIONS = 100_000;

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
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
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
    if (key !== name) continue;
    const raw = value.join("=");
    // A malformed percent-encoding must not take the whole request down;
    // an undecodable token simply fails the session lookup.
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
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

export function clearSessionCookie() {
  return sessionCookie("", 0);
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
  )
    .bind(handle)
    .first<AuthRow>();
}

/**
 * Retrieves the user associated with the request's valid, unexpired session.
 *
 * @returns The session user, or `null` when no valid session exists or the lookup fails.
 */
export async function getSessionUser(request: Request, env: AppEnv): Promise<SessionUser | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;

  try {
    const idHash = await sha256(token);
    const row = await env.DB.prepare(
      `SELECT u.id, u.handle, u.display_name, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at > datetime('now')
       LIMIT 1`,
    )
      .bind(idHash)
      .first<Omit<AuthRow, "password_hash" | "password_salt">>();
    if (!row) return null;
    return {
      id: row.id,
      handle: row.handle,
      displayName: row.display_name,
      role: row.role,
    };
  } catch (error) {
    console.error("getSessionUser failed", error);
    return null;
  }
}

/**
 * Creates a session for a user and returns its session cookie.
 *
 * @param userId - The ID of the user associated with the session
 * @param ctx - When provided, expired sessions are purged after the response is sent
 * @returns A session cookie containing the session token
 */
export async function createSession(env: AppEnv, userId: string, ctx?: ExecutionContext) {
  const token = randomToken();
  const idHash = await sha256(token);
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  // Keep this write as a single statement.  The former D1 batch combined a
  // best-effort expired-session cleanup with the required login write; if the
  // cleanup failed, registration completed but the response became a 500.
  await env.DB.prepare("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(idHash, userId, expires)
    .run();
  ctx?.waitUntil(
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')")
      .run()
      .catch((error) => console.error("expired session cleanup failed", error)),
  );
  return sessionCookie(token, SESSION_DAYS * 86_400);
}

export async function destroySession(request: Request, env: AppEnv) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token)
    await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?")
      .bind(await sha256(token))
      .run();
  return clearSessionCookie();
}

/**
 * Sets a new password for the user and revokes every other session.
 *
 * The session attached to the current request survives so the user stays
 * logged in on this device; all other devices must log in again.
 */
export async function changePassword(request: Request, env: AppEnv, userId: string, newPassword: string) {
  const { hash, salt } = await hashPassword(newPassword);
  const token = cookieValue(request, SESSION_COOKIE);
  const currentIdHash = token ? await sha256(token) : null;
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?").bind(hash, salt, userId),
    currentIdHash
      ? env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?").bind(userId, currentIdHash)
      : env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
  ]);
}

const DUMMY_SALT = "00000000000000000000000000000000";
const DUMMY_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

export async function verifyPasswordOrDummy(
  password: string,
  hash: string | null | undefined,
  salt: string | null | undefined,
): Promise<boolean> {
  if (hash && salt) return verifyPassword(password, hash, salt);
  await verifyPassword(password, DUMMY_HASH, DUMMY_SALT);
  return false;
}
