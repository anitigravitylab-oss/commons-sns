import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp, createUser, failingEnv, resetData, type TestApp } from "../testing/d1";
import { createExecutionContext, getRequest, loginCookie } from "../testing/requests";
import {
  changePassword,
  clearSessionCookie,
  createSession,
  destroySession,
  findUserForLogin,
  getSessionUser,
  hashPassword,
  SESSION_COOKIE,
  verifyPassword,
  verifyPasswordOrDummy,
} from "./auth.server";

describe("password hashing", () => {
  it("verifies a password against its own hash", async () => {
    const { hash, salt } = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash, salt)).toBe(true);
    expect(await verifyPassword("wrong password!", hash, salt)).toBe(false);
  });

  it("produces hex-encoded salt and hash", async () => {
    const { hash, salt } = await hashPassword("some password");
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("salts every hash independently", async () => {
    const first = await hashPassword("same password");
    const second = await hashPassword("same password");
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
  });

  it("fails closed on a corrupted stored salt instead of throwing", async () => {
    const { hash } = await hashPassword("some password");
    expect(await verifyPassword("some password", hash, "")).toBe(false);
  });
});

describe("verifyPasswordOrDummy", () => {
  it("verifies against real credentials", async () => {
    const { hash, salt } = await hashPassword("open sesame 123");
    expect(await verifyPasswordOrDummy("open sesame 123", hash, salt)).toBe(true);
    expect(await verifyPasswordOrDummy("not the password", hash, salt)).toBe(false);
  });

  it("returns false for accounts without a password instead of throwing", async () => {
    expect(await verifyPasswordOrDummy("anything at all", null, null)).toBe(false);
    expect(await verifyPasswordOrDummy("anything at all", undefined, undefined)).toBe(false);
    // A half-set credential pair must also fail closed.
    const { hash } = await hashPassword("half-set");
    expect(await verifyPasswordOrDummy("half-set", hash, null)).toBe(false);
  });
});

describe("session cookies", () => {
  it("clearSessionCookie expires the cookie immediately with the same attributes", () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain(`${SESSION_COOKIE}=;`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });
});

describe("sessions against D1", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.dispose();
  });

  beforeEach(async () => {
    await resetData(app.env);
  });

  it("findUserForLogin matches handles case-insensitively", async () => {
    const user = await createUser(app.env, { handle: "casetest" });
    const found = await findUserForLogin(app.env, "CaseTest");
    expect(found?.id).toBe(user.id);
    expect(found?.password_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await findUserForLogin(app.env, "missing_handle")).toBeNull();
  });

  it("createSession stores only a hash of the token and sets a 30-day cookie", async () => {
    const user = await createUser(app.env);
    const setCookie = await createSession(app.env, user.id);

    expect(setCookie).toContain("Max-Age=2592000");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");

    const token = setCookie.split(";")[0].split("=")[1];
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const row = await app.env.DB.prepare("SELECT id_hash, user_id, expires_at FROM sessions").first<{
      id_hash: string;
      user_id: string;
      expires_at: string;
    }>();
    expect(row?.user_id).toBe(user.id);
    // The raw token must never be persisted — only its SHA-256 digest is.
    expect(row?.id_hash).not.toBe(token);
    expect(row?.id_hash).toMatch(/^[0-9a-f]{64}$/);
    const msUntilExpiry = new Date(row?.expires_at ?? "").getTime() - Date.now();
    expect(msUntilExpiry).toBeGreaterThan(29 * 86_400_000);
    expect(msUntilExpiry).toBeLessThanOrEqual(30 * 86_400_000);
  });

  it("getSessionUser resolves the cookie back to the user", async () => {
    const user = await createUser(app.env, { displayName: "せっしょん", role: "user" });
    const cookie = await loginCookie(app.env, user.id);

    const sessionUser = await getSessionUser(getRequest("http://test.local/", { cookie }), app.env);
    expect(sessionUser).toEqual({
      id: user.id,
      handle: user.handle,
      displayName: "せっしょん",
      role: "user",
    });
  });

  it("getSessionUser reads the session cookie out of a crowded Cookie header", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    const crowded = `theme=dark; ${cookie}; consent=1`;
    const sessionUser = await getSessionUser(getRequest("http://test.local/", { cookie: crowded }), app.env);
    expect(sessionUser?.id).toBe(user.id);
  });

  it("getSessionUser returns null without a cookie, for unknown tokens and for malformed encodings", async () => {
    await createUser(app.env);
    expect(await getSessionUser(getRequest("http://test.local/"), app.env)).toBeNull();

    const unknown = getRequest("http://test.local/", { cookie: `${SESSION_COOKIE}=${"0".repeat(64)}` });
    expect(await getSessionUser(unknown, app.env)).toBeNull();

    // Undecodable percent-encoding must not crash the request.
    const malformed = getRequest("http://test.local/", { cookie: `${SESSION_COOKIE}=%zz%` });
    expect(await getSessionUser(malformed, app.env)).toBeNull();
  });

  it("getSessionUser ignores expired sessions", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    await app.env.DB.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 minute')").run();
    expect(await getSessionUser(getRequest("http://test.local/", { cookie }), app.env)).toBeNull();
  });

  it("getSessionUser fails closed when the database is unavailable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const request = getRequest("http://test.local/", { cookie: `${SESSION_COOKIE}=deadbeef` });
      const broken = {
        DB: {
          prepare() {
            throw new Error("simulated D1 outage");
          },
        },
      } as unknown as typeof app.env;
      expect(await getSessionUser(request, broken)).toBeNull();
      expect(consoleError).toHaveBeenCalledWith("getSessionUser failed", expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("createSession purges expired sessions in the background when a context is provided", async () => {
    const user = await createUser(app.env);
    await app.env.DB.prepare(
      "INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ('stale', ?, datetime('now', '-1 day'))",
    )
      .bind(user.id)
      .run();

    const { ctx, waitForBackgroundTasks } = createExecutionContext();
    await createSession(app.env, user.id, ctx);
    await waitForBackgroundTasks();

    const stale = await app.env.DB.prepare("SELECT 1 AS present FROM sessions WHERE id_hash = 'stale'").first();
    expect(stale).toBeNull();
    const live = await app.env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
    expect(live?.n).toBe(1);
  });

  it("createSession still succeeds when the background cleanup fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const user = await createUser(app.env);
      const env = failingEnv(app.env, "DELETE FROM sessions WHERE expires_at");
      const { ctx, waitForBackgroundTasks } = createExecutionContext();

      const setCookie = await createSession(env, user.id, ctx);
      await waitForBackgroundTasks();

      // The login write went through even though the cleanup blew up.
      expect(setCookie).toContain(`${SESSION_COOKIE}=`);
      const count = await app.env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
      expect(count?.n).toBe(1);
      expect(consoleError).toHaveBeenCalledWith("expired session cleanup failed", expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("destroySession deletes the session and returns a clearing cookie", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);

    const setCookie = await destroySession(getRequest("http://test.local/", { cookie }), app.env);
    expect(setCookie).toContain("Max-Age=0");
    expect(await getSessionUser(getRequest("http://test.local/", { cookie }), app.env)).toBeNull();
    const remaining = await app.env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  it("destroySession without a cookie still returns a clearing cookie", async () => {
    const setCookie = await destroySession(getRequest("http://test.local/"), app.env);
    expect(setCookie).toContain("Max-Age=0");
  });

  it("changePassword rotates credentials and revokes every other session", async () => {
    const user = await createUser(app.env, { password: "original pass 1" });
    const currentCookie = await loginCookie(app.env, user.id);
    const otherCookie = await loginCookie(app.env, user.id);

    await changePassword(getRequest("http://test.local/", { cookie: currentCookie }), app.env, user.id, "new pass 42");

    const account = await findUserForLogin(app.env, user.handle);
    expect(await verifyPassword("new pass 42", account?.password_hash ?? "", account?.password_salt ?? "")).toBe(true);
    expect(await verifyPassword("original pass 1", account?.password_hash ?? "", account?.password_salt ?? "")).toBe(
      false,
    );

    // The device that changed the password stays logged in; others do not.
    expect(await getSessionUser(getRequest("http://test.local/", { cookie: currentCookie }), app.env)).not.toBeNull();
    expect(await getSessionUser(getRequest("http://test.local/", { cookie: otherCookie }), app.env)).toBeNull();
  });

  it("changePassword without a request cookie revokes every session", async () => {
    const user = await createUser(app.env);
    await loginCookie(app.env, user.id);
    await loginCookie(app.env, user.id);

    await changePassword(getRequest("http://test.local/"), app.env, user.id, "brand new pass");

    const remaining = await app.env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });
});
