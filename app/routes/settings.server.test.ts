import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionUser, verifyPassword } from "../lib/auth.server";
import { consumeToken, RATE_LIMITS, resetRateLimits } from "../lib/rate-limit.server";
import { addFollow, addReaction, createPost, createTestApp, createUser, resetData, type TestApp } from "../testing/d1";
import {
  expectData,
  expectRedirect,
  formRequest,
  getRequest,
  loginCookie,
  malformedFormRequest,
  routeArgs,
} from "../testing/requests";
import { action, loader } from "./settings";

type ActionResult = { ok?: boolean; error?: string; form?: "password" | "delete" };

let app: TestApp;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.dispose();
});

beforeEach(async () => {
  await resetData(app.env);
  // レートリミットは isolate メモリに残るのでテスト間で持ち越さない。
  resetRateLimits();
});

const URL_SETTINGS = "http://test.local/settings";

function callAction(request: Request, env = app.env) {
  return action(routeArgs(request, env, { pattern: "/settings" }));
}

function callLoader(request: Request, env = app.env) {
  return loader(routeArgs(request, env, { pattern: "/settings" }));
}

describe("settings loader", () => {
  it("redirects anonymous visitors to the login modal", async () => {
    const result = await callLoader(getRequest(URL_SETTINGS));
    expect(expectRedirect(result).location).toBe("/?auth=login");
  });

  it("returns the session user", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    const result = await callLoader(getRequest(URL_SETTINGS, { cookie }));
    expect(expectData<{ user: { id: string } }>(result).data.user.id).toBe(user.id);
  });
});

describe("settings action envelope", () => {
  it("redirects anonymous submissions to the login modal", async () => {
    const result = await callAction(formRequest(URL_SETTINGS, { intent: "changePassword" }));
    expect(expectRedirect(result).location).toBe("/?auth=login");
  });

  it("rejects unknown intents", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    const result = await callAction(formRequest(URL_SETTINGS, { intent: "hack" }, { cookie }));
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(400);
    expect(data.error).toBe("不明な操作です。");
  });

  it("returns a friendly 500 when the body is not form data", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const user = await createUser(app.env);
      const cookie = await loginCookie(app.env, user.id);
      const result = await callAction(malformedFormRequest(URL_SETTINGS, { cookie }));
      expect(expectData<ActionResult>(result).status).toBe(500);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("logs out and clears the session", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    const result = await callAction(formRequest(URL_SETTINGS, { intent: "logout" }, { cookie }));
    const { location, setCookie } = expectRedirect(result);
    expect(location).toBe("/");
    expect(setCookie).toContain("Max-Age=0");
    expect(await getSessionUser(getRequest("http://test.local/", { cookie }), app.env)).toBeNull();
  });
});

describe("settings request guards", () => {
  it("別サイトからの送信は 403（退会・パスワード変更を踏ませない）", async () => {
    const user = await createUser(app.env, { handle: "csrf_settings" });
    const cookie = await loginCookie(app.env, user.id);

    const result = await callAction(
      formRequest(
        URL_SETTINGS,
        { intent: "deleteAccount", password: "correct horse battery", confirmation: "csrf_settings" },
        { cookie, origin: "https://evil.example" },
      ),
    );

    expect((result as Response).status).toBe(403);
    const remaining = await app.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(remaining?.n).toBe(1);
  });

  it("本文が大きすぎる送信は読まずに 413", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);

    const result = await callAction(
      formRequest(URL_SETTINGS, { intent: "logout" }, { cookie, contentLength: 1_048_576 }),
    );

    expect(expectData<ActionResult>(result).status).toBe(413);
  });

  it("過大な本文はセッションを引く前に落とす（未ログインでもリダイレクトしない）", async () => {
    // セッションを先に引くと、この送信だけで 413 の前に D1 への往復を踏ませられる。
    const result = await callAction(formRequest(URL_SETTINGS, { intent: "logout" }, { contentLength: 1_048_576 }));

    expect(expectData<ActionResult>(result).status).toBe(413);
  });
});

describe("changePassword", () => {
  const fields = {
    intent: "changePassword",
    currentPassword: "correct horse battery",
    newPassword: "brand new pass 1",
    newPasswordConfirm: "brand new pass 1",
  };

  it("changes the password and keeps only the current session alive", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    const otherCookie = await loginCookie(app.env, user.id);

    const result = await callAction(formRequest(URL_SETTINGS, fields, { cookie }));
    const { data } = expectData<ActionResult>(result);
    expect(data).toEqual({ ok: true, form: "password" });

    const account = await app.env.DB.prepare("SELECT password_hash, password_salt FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ password_hash: string; password_salt: string }>();
    expect(await verifyPassword("brand new pass 1", account?.password_hash ?? "", account?.password_salt ?? "")).toBe(
      true,
    );

    expect(await getSessionUser(getRequest(URL_SETTINGS, { cookie }), app.env)).not.toBeNull();
    expect(await getSessionUser(getRequest(URL_SETTINGS, { cookie: otherCookie }), app.env)).toBeNull();
  });

  it("rejects a new password outside the allowed range", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    const result = await callAction(
      formRequest(URL_SETTINGS, { ...fields, newPassword: "short", newPasswordConfirm: "short" }, { cookie }),
    );
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(400);
    expect(data.form).toBe("password");
    expect(data.error).toBe("新しいパスワードは8〜128文字で入力してください。");
  });

  it("rejects a mismatched confirmation", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    const result = await callAction(
      formRequest(URL_SETTINGS, { ...fields, newPasswordConfirm: "brand new pass 2" }, { cookie }),
    );
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(400);
    expect(data.error).toBe("新しいパスワードが確認用と一致しません。");
  });

  it("rejects a wrong current password without changing anything", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    const result = await callAction(
      formRequest(URL_SETTINGS, { ...fields, currentPassword: "not my password" }, { cookie }),
    );
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(401);
    expect(data.error).toBe("現在のパスワードが違います。");

    const account = await app.env.DB.prepare("SELECT password_hash, password_salt FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ password_hash: string; password_salt: string }>();
    expect(
      await verifyPassword("correct horse battery", account?.password_hash ?? "", account?.password_salt ?? ""),
    ).toBe(true);
  });
});

describe("deleteAccount", () => {
  it("requires the exact handle confirmation", async () => {
    const user = await createUser(app.env, { handle: "leaver" });
    const cookie = await loginCookie(app.env, user.id);
    const result = await callAction(
      formRequest(
        URL_SETTINGS,
        { intent: "deleteAccount", password: "correct horse battery", confirmation: "somebody_else" },
        { cookie },
      ),
    );
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(400);
    expect(data.form).toBe("delete");
    expect(data.error).toBe("確認用のユーザーIDが一致しません。");
  });

  it("requires the correct password", async () => {
    const user = await createUser(app.env, { handle: "leaver" });
    const cookie = await loginCookie(app.env, user.id);
    const result = await callAction(
      formRequest(
        URL_SETTINGS,
        { intent: "deleteAccount", password: "wrong password", confirmation: "leaver" },
        { cookie },
      ),
    );
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(401);
    expect(data.error).toBe("パスワードが違います。");
    const stillThere = await app.env.DB.prepare("SELECT 1 AS present FROM users WHERE id = ?").bind(user.id).first();
    expect(stillThere).not.toBeNull();
  });

  it("deletes the account and every trace of it, leaving others untouched", async () => {
    const user = await createUser(app.env, { handle: "leaver" });
    const bystander = await createUser(app.env, { handle: "bystander" });

    await createPost(app.env, { id: "users_post", authorId: user.id });
    await createPost(app.env, { id: "bystanders_post", authorId: bystander.id });
    // Reactions in both directions, follows in both directions.
    await addReaction(app.env, { userId: user.id, postId: "bystanders_post", kind: "like" });
    await addReaction(app.env, { userId: bystander.id, postId: "users_post", kind: "like" });
    await addReaction(app.env, { userId: bystander.id, postId: "bystanders_post", kind: "bookmark" });
    await addFollow(app.env, user.id, bystander.id);
    await addFollow(app.env, bystander.id, user.id);
    await app.env.DB.prepare(
      "INSERT INTO media (id, owner_id, r2_key, mime_type) VALUES ('m1', ?, 'key1', 'image/png')",
    )
      .bind(user.id)
      .run();

    const cookie = await loginCookie(app.env, user.id);
    // The confirmation tolerates whitespace, case and a leading @.
    const result = await callAction(
      formRequest(
        URL_SETTINGS,
        { intent: "deleteAccount", password: "correct horse battery", confirmation: " @Leaver " },
        { cookie },
      ),
    );
    const { location, setCookie } = expectRedirect(result);
    expect(location).toBe("/");
    expect(setCookie).toContain("Max-Age=0");

    const counts = await app.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM posts) AS posts,
         (SELECT COUNT(*) FROM post_reactions) AS reactions,
         (SELECT COUNT(*) FROM follows) AS follows,
         (SELECT COUNT(*) FROM sessions) AS sessions,
         (SELECT COUNT(*) FROM media) AS media`,
    ).first<{ users: number; posts: number; reactions: number; follows: number; sessions: number; media: number }>();
    // Only the bystander and their own content remain.
    expect(counts).toEqual({ users: 1, posts: 1, reactions: 1, follows: 0, sessions: 0, media: 0 });
    const remainingUser = await app.env.DB.prepare("SELECT handle FROM users").first<{ handle: string }>();
    expect(remainingUser?.handle).toBe("bystander");
    const remainingReaction = await app.env.DB.prepare("SELECT user_id, post_id FROM post_reactions").first<{
      user_id: string;
      post_id: string;
    }>();
    expect(remainingReaction).toEqual({ user_id: bystander.id, post_id: "bystanders_post" });
  });
});

describe("settings rate limits", () => {
  it("stops repeated credential operations with 429 before hashing anything", async () => {
    const user = await createUser(app.env, { handle: "owner" });
    const cookie = await loginCookie(app.env, user.id);
    // パスワード変更と退会は同じ枠（PBKDF2 の CPU を守るため）を共有する。
    // 主体は「利用者 × 送信元」。テストの送信は CF-Connecting-IP を持たないので "unknown"。
    for (let index = 0; index < RATE_LIMITS.credential.capacity; index += 1) {
      consumeToken("credential", `${user.id}:unknown`);
    }

    const changed = await callAction(
      formRequest(
        URL_SETTINGS,
        {
          intent: "changePassword",
          currentPassword: "correct horse battery",
          newPassword: "brand new pass 1",
          newPasswordConfirm: "brand new pass 1",
        },
        { cookie },
      ),
    );
    expect(expectData<ActionResult>(changed)).toMatchObject({
      status: 429,
      data: { form: "password", error: "操作が多すぎます。しばらく待ってからお試しください。" },
    });

    const deleted = await callAction(
      formRequest(
        URL_SETTINGS,
        { intent: "deleteAccount", password: "correct horse battery", confirmation: "owner" },
        { cookie },
      ),
    );
    expect(expectData<ActionResult>(deleted)).toMatchObject({ status: 429, data: { form: "delete" } });

    // どちらも実行されていない（パスワードは元のまま、アカウントも残っている）。
    const account = await app.env.DB.prepare("SELECT password_hash, password_salt FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ password_hash: string; password_salt: string }>();
    expect(
      await verifyPassword("correct horse battery", account?.password_hash ?? "", account?.password_salt ?? ""),
    ).toBe(true);
  });

  it("確認欄の入力ミスでは枠を消費しない", async () => {
    // 検証より前に消費すると、確認用の欄を打ち間違えただけで枠が空になり、
    // パスワード変更も退会もできなくなる（どちらも同じ枠を共有しているため）。
    const user = await createUser(app.env, { handle: "typo" });
    const cookie = await loginCookie(app.env, user.id);

    for (let index = 0; index < RATE_LIMITS.credential.capacity; index += 1) {
      const mismatch = await callAction(
        formRequest(
          URL_SETTINGS,
          {
            intent: "changePassword",
            currentPassword: "correct horse battery",
            newPassword: "brand new pass 1",
            newPasswordConfirm: "typed it wrong",
          },
          { cookie },
        ),
      );
      expect(expectData<ActionResult>(mismatch).status).toBe(400);
    }

    // 退会側の確認欄の打ち間違いも、同じ枠を減らさない。
    const wrongConfirmation = await callAction(
      formRequest(
        URL_SETTINGS,
        { intent: "deleteAccount", password: "correct horse battery", confirmation: "someone_else" },
        { cookie },
      ),
    );
    expect(expectData<ActionResult>(wrongConfirmation).status).toBe(400);

    // 枠は満タンのままなので、正しい入力はそのまま通る。
    const changed = await callAction(
      formRequest(
        URL_SETTINGS,
        {
          intent: "changePassword",
          currentPassword: "correct horse battery",
          newPassword: "brand new pass 1",
          newPasswordConfirm: "brand new pass 1",
        },
        { cookie },
      ),
    );
    expect(expectData<ActionResult>(changed)).toMatchObject({ status: 200, data: { ok: true } });
  });

  it("leaves logout unthrottled", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    for (let index = 0; index < RATE_LIMITS.credential.capacity; index += 1) {
      consumeToken("credential", `${user.id}:unknown`);
    }

    const result = await callAction(formRequest(URL_SETTINGS, { intent: "logout" }, { cookie }));
    expect(expectRedirect(result).location).toBe("/");
  });

  it("別の送信元からの復旧操作は、盗まれたセッション側の消費に巻き込まれない", async () => {
    // 攻撃者が失敗する送信で枠を空にしても、本人（別 IP）のパスワード変更は通ること。
    // これが通らないと、乗っ取られたセッションを失効させる唯一の手段を塞がれる。
    const user = await createUser(app.env, { handle: "victim" });
    const cookie = await loginCookie(app.env, user.id);
    const attackerIp = "203.0.113.9";
    for (let index = 0; index < RATE_LIMITS.credential.capacity; index += 1) {
      consumeToken("credential", `${user.id}:${attackerIp}`);
    }

    const blocked = await callAction(
      formRequest(
        URL_SETTINGS,
        { intent: "deleteAccount", password: "x", confirmation: "victim" },
        { cookie, ip: attackerIp },
      ),
    );
    expect(expectData<ActionResult>(blocked).status).toBe(429);

    const owner = await callAction(
      formRequest(
        URL_SETTINGS,
        {
          intent: "changePassword",
          currentPassword: "correct horse battery",
          newPassword: "brand new pass 1",
          newPasswordConfirm: "brand new pass 1",
        },
        { cookie, ip: "198.51.100.4" },
      ),
    );
    expect(expectData<ActionResult>(owner)).toMatchObject({ status: 200, data: { ok: true } });
  });
});
