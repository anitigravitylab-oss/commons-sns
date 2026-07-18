import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionUser, SESSION_COOKIE, verifyPassword } from "../lib/auth.server";
import { brokenEnv, createPost, createTestApp, createUser, failingEnv, resetData, type TestApp } from "../testing/d1";
import {
  expectData,
  expectRedirect,
  formRequest,
  getRequest,
  loginCookie,
  malformedFormRequest,
  routeArgs,
} from "../testing/requests";
import { action, loader } from "./home";

type ActionResult = { ok?: boolean; error?: string; form?: "login" | "signup" };

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

const URL_HOME = "http://test.local/?index";

function callAction(request: Request, env = app.env) {
  return action(routeArgs(request, env, { pattern: "/" }));
}

function callLoader(request: Request, env = app.env) {
  return loader(routeArgs(request, env, { pattern: "/" }));
}

describe("home loader", () => {
  it("serves the recommended timeline to anonymous visitors", async () => {
    const author = await createUser(app.env);
    await createPost(app.env, { id: "visible", authorId: author.id });

    const result = await callLoader(getRequest("http://test.local/"));
    expect(result.user).toBeNull();
    expect(result.tab).toBe("recommended");
    expect(result.timelineError).toBe(false);
    expect(result.posts.map((post) => post.id)).toEqual(["visible"]);
  });

  it("ignores tab=following for anonymous visitors", async () => {
    const result = await callLoader(getRequest("http://test.local/?tab=following"));
    expect(result.tab).toBe("recommended");
  });

  it("serves the following timeline to logged-in users", async () => {
    const viewer = await createUser(app.env);
    const stranger = await createUser(app.env);
    await createPost(app.env, { id: "own_post", authorId: viewer.id, createdAt: "2026-06-01 10:00:00" });
    await createPost(app.env, { id: "stranger_post", authorId: stranger.id, createdAt: "2026-06-01 11:00:00" });
    const cookie = await loginCookie(app.env, viewer.id);

    const result = await callLoader(getRequest("http://test.local/?tab=following", { cookie }));
    expect(result.user?.id).toBe(viewer.id);
    expect(result.tab).toBe("following");
    expect(result.posts.map((post) => post.id)).toEqual(["own_post"]);
  });

  it("degrades to an empty timeline with an error flag when D1 fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await callLoader(getRequest("http://test.local/"), brokenEnv());
      expect(result.user).toBeNull();
      expect(result.posts).toEqual([]);
      expect(result.timelineError).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("signup", () => {
  const signupFields = {
    intent: "signup",
    handle: "newcomer",
    displayName: "新人",
    password: "password123",
  };

  it("creates the account, hashes the password and starts a session", async () => {
    const result = await callAction(formRequest(URL_HOME, signupFields));

    const { location, setCookie } = expectRedirect(result);
    expect(location).toBe("/");
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");

    const row = await app.env.DB.prepare(
      "SELECT handle, display_name, role, password_hash, password_salt FROM users WHERE handle = 'newcomer'",
    ).first<{ handle: string; display_name: string; role: string; password_hash: string; password_salt: string }>();
    expect(row?.display_name).toBe("新人");
    expect(row?.role).toBe("user");
    expect(row?.password_hash).not.toContain("password123");
    expect(await verifyPassword("password123", row?.password_hash ?? "", row?.password_salt ?? "")).toBe(true);

    // The Set-Cookie from the redirect is a live session.
    const cookie = (setCookie ?? "").split(";")[0];
    const sessionUser = await getSessionUser(getRequest("http://test.local/", { cookie }), app.env);
    expect(sessionUser?.handle).toBe("newcomer");
  });

  it("normalizes the handle: trims, lowercases and strips a leading @", async () => {
    const result = await callAction(formRequest(URL_HOME, { ...signupFields, handle: "  @NewComer " }));
    expectRedirect(result);
    const row = await app.env.DB.prepare("SELECT handle FROM users WHERE handle = 'newcomer'").first();
    expect(row).not.toBeNull();
  });

  it.each([
    ["ab", "too short"],
    ["a".repeat(21), "too long"],
    ["invalid-dash", "hyphen"],
    ["日本語はんどる", "non-ascii"],
    ["", "empty"],
  ])("rejects the handle %j (%s)", async (handle) => {
    const result = await callAction(formRequest(URL_HOME, { ...signupFields, handle }));
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(400);
    expect(data.form).toBe("signup");
    expect(data.error).toBe("IDは3〜20文字の半角英数字と_で入力してください。");
  });

  it("rejects reserved handles regardless of case", async () => {
    const result = await callAction(formRequest(URL_HOME, { ...signupFields, handle: "Admin" }));
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(400);
    expect(data.error).toBe("このIDは使用できません。");
  });

  it("rejects display names that are empty after sanitizing or too long", async () => {
    const empty = await callAction(formRequest(URL_HOME, { ...signupFields, displayName: " \u200b " }));
    expect(expectData<ActionResult>(empty).status).toBe(400);

    const long = await callAction(formRequest(URL_HOME, { ...signupFields, displayName: "あ".repeat(31) }));
    const { data, status } = expectData<ActionResult>(long);
    expect(status).toBe(400);
    expect(data.error).toBe("表示名は1〜30文字で入力してください。");
  });

  it("accepts a 30-code-point emoji display name", async () => {
    const result = await callAction(formRequest(URL_HOME, { ...signupFields, displayName: "😀".repeat(30) }));
    expectRedirect(result);
  });

  it("rejects out-of-range passwords", async () => {
    const short = await callAction(formRequest(URL_HOME, { ...signupFields, password: "1234567" }));
    expect(expectData<ActionResult>(short).status).toBe(400);

    const long = await callAction(formRequest(URL_HOME, { ...signupFields, password: "x".repeat(129) }));
    const { data, status } = expectData<ActionResult>(long);
    expect(status).toBe(400);
    expect(data.error).toBe("パスワードは8〜128文字で入力してください。");
  });

  it("returns 409 when the handle is already taken, even with different casing", async () => {
    await createUser(app.env, { handle: "taken" });
    const result = await callAction(formRequest(URL_HOME, { ...signupFields, handle: "TAKEN" }));
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(409);
    expect(data.form).toBe("signup");
    expect(data.error).toBe("そのIDはすでに使われています。");
  });

  it("maps non-constraint insert failures to a 500 signup error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = failingEnv(app.env, "INSERT INTO users");
      const result = await callAction(formRequest(URL_HOME, signupFields), env);
      const { data, status } = expectData<ActionResult>(result);
      expect(status).toBe(500);
      expect(data.form).toBe("signup");
      expect(data.error).toBe("登録できませんでした。時間をおいてもう一度お試しください。");
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("login and logout", () => {
  it("logs in with the correct password, tolerating @ and case in the handle", async () => {
    const user = await createUser(app.env, { handle: "member", password: "secret pass 9" });

    const result = await callAction(
      formRequest(URL_HOME, { intent: "login", handle: "@Member", password: "secret pass 9" }),
    );
    const { location, setCookie } = expectRedirect(result);
    expect(location).toBe("/");

    const cookie = (setCookie ?? "").split(";")[0];
    const sessionUser = await getSessionUser(getRequest("http://test.local/", { cookie }), app.env);
    expect(sessionUser?.id).toBe(user.id);
  });

  it("rejects a wrong password and an unknown handle with the same message", async () => {
    await createUser(app.env, { handle: "member", password: "secret pass 9" });

    for (const fields of [
      { intent: "login", handle: "member", password: "wrong password" },
      { intent: "login", handle: "ghost", password: "whatever pass" },
    ]) {
      const result = await callAction(formRequest(URL_HOME, fields));
      const { data, status } = expectData<ActionResult>(result);
      expect(status).toBe(401);
      expect(data.form).toBe("login");
      expect(data.error).toBe("IDまたはパスワードが違います。");
    }
  });

  it("rejects passwords outside the accepted range before touching the database", async () => {
    const result = await callAction(formRequest(URL_HOME, { intent: "login", handle: "member", password: "short" }));
    expect(expectData<ActionResult>(result).status).toBe(401);
  });

  it("rejects logins for passwordless (seed) accounts", async () => {
    await createUser(app.env, { handle: "legacy", password: null });
    const result = await callAction(
      formRequest(URL_HOME, { intent: "login", handle: "legacy", password: "any password here" }),
    );
    expect(expectData<ActionResult>(result).status).toBe(401);
  });

  it("logout destroys the session and clears the cookie", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);

    const result = await callAction(formRequest(URL_HOME, { intent: "logout" }, { cookie }));
    const { location, setCookie } = expectRedirect(result);
    expect(location).toBe("/");
    expect(setCookie).toContain("Max-Age=0");
    expect(await getSessionUser(getRequest("http://test.local/", { cookie }), app.env)).toBeNull();
  });
});

describe("createPost", () => {
  it("requires a login", async () => {
    const result = await callAction(formRequest(URL_HOME, { intent: "createPost", body: "こんにちは" }));
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(401);
    expect(data.form).toBe("login");
    expect(data.error).toBe("この操作にはログインが必要です。");
  });

  it("stores a sanitized post for the session user", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);

    const result = await callAction(
      formRequest(URL_HOME, { intent: "createPost", body: "  一行目\r\n二行目\u200b  " }, { cookie }),
    );
    expect(expectData<ActionResult>(result).data.ok).toBe(true);

    const row = await app.env.DB.prepare("SELECT author_id, body, visibility FROM posts").first<{
      author_id: string;
      body: string;
      visibility: string;
    }>();
    expect(row?.author_id).toBe(user.id);
    expect(row?.body).toBe("一行目\n二行目");
    expect(row?.visibility).toBe("public");
  });

  it("accepts exactly 280 code points and rejects 281", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);

    const ok = await callAction(formRequest(URL_HOME, { intent: "createPost", body: "あ".repeat(280) }, { cookie }));
    expect(expectData<ActionResult>(ok).data.ok).toBe(true);

    const over = await callAction(formRequest(URL_HOME, { intent: "createPost", body: "あ".repeat(281) }, { cookie }));
    const { data, status } = expectData<ActionResult>(over);
    expect(status).toBe(400);
    expect(data.error).toBe("投稿は1〜280文字で入力してください。");
  });

  it("rejects posts that sanitize down to nothing", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    const result = await callAction(formRequest(URL_HOME, { intent: "createPost", body: " \u200b\n " }, { cookie }));
    expect(expectData<ActionResult>(result).status).toBe(400);
    const count = await app.env.DB.prepare("SELECT COUNT(*) AS n FROM posts").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe("toggleReaction", () => {
  it("adds then removes a reaction", async () => {
    const author = await createUser(app.env);
    const user = await createUser(app.env);
    await createPost(app.env, { id: "target", authorId: author.id });
    const cookie = await loginCookie(app.env, user.id);

    const like = () =>
      callAction(formRequest(URL_HOME, { intent: "toggleReaction", postId: "target", kind: "like" }, { cookie }));

    expect(expectData<ActionResult>(await like()).data.ok).toBe(true);
    let rows = await app.env.DB.prepare("SELECT kind FROM post_reactions WHERE user_id = ?").bind(user.id).all();
    expect(rows.results).toEqual([{ kind: "like" }]);

    expect(expectData<ActionResult>(await like()).data.ok).toBe(true);
    rows = await app.env.DB.prepare("SELECT kind FROM post_reactions WHERE user_id = ?").bind(user.id).all();
    expect(rows.results).toEqual([]);
  });

  it("keeps like, repost and bookmark independent", async () => {
    const author = await createUser(app.env);
    const user = await createUser(app.env);
    await createPost(app.env, { id: "target", authorId: author.id });
    const cookie = await loginCookie(app.env, user.id);

    for (const kind of ["like", "repost", "bookmark"]) {
      await callAction(formRequest(URL_HOME, { intent: "toggleReaction", postId: "target", kind }, { cookie }));
    }
    const rows = await app.env.DB.prepare("SELECT kind FROM post_reactions WHERE user_id = ? ORDER BY kind")
      .bind(user.id)
      .all();
    expect(rows.results).toEqual([{ kind: "bookmark" }, { kind: "like" }, { kind: "repost" }]);
  });

  it("rejects unknown kinds and missing post ids", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);

    const badKind = await callAction(
      formRequest(URL_HOME, { intent: "toggleReaction", postId: "x", kind: "applaud" }, { cookie }),
    );
    const { data, status } = expectData<ActionResult>(badKind);
    expect(status).toBe(400);
    expect(data.error).toBe("不正な操作です。");

    const noPost = await callAction(formRequest(URL_HOME, { intent: "toggleReaction", kind: "like" }, { cookie }));
    expect(expectData<ActionResult>(noPost).status).toBe(400);
  });

  it("silently refuses to react to deleted or nonexistent posts", async () => {
    const author = await createUser(app.env);
    const user = await createUser(app.env);
    await createPost(app.env, { id: "gone", authorId: author.id, deletedAt: "2026-06-01 00:00:00" });
    const cookie = await loginCookie(app.env, user.id);

    for (const postId of ["gone", "never_existed"]) {
      const result = await callAction(
        formRequest(URL_HOME, { intent: "toggleReaction", postId, kind: "like" }, { cookie }),
      );
      expect(expectData<ActionResult>(result).data.ok).toBe(true);
    }
    const count = await app.env.DB.prepare("SELECT COUNT(*) AS n FROM post_reactions").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe("deletePost", () => {
  it("soft-deletes the author's own post only", async () => {
    const author = await createUser(app.env);
    const intruder = await createUser(app.env);
    await createPost(app.env, { id: "victim", authorId: author.id });

    const intruderCookie = await loginCookie(app.env, intruder.id);
    const blocked = await callAction(
      formRequest(URL_HOME, { intent: "deletePost", postId: "victim" }, { cookie: intruderCookie }),
    );
    expect(expectData<ActionResult>(blocked).data.ok).toBe(true);
    let row = await app.env.DB.prepare("SELECT deleted_at FROM posts WHERE id = 'victim'").first<{
      deleted_at: string | null;
    }>();
    expect(row?.deleted_at).toBeNull();

    const authorCookie = await loginCookie(app.env, author.id);
    const allowed = await callAction(
      formRequest(URL_HOME, { intent: "deletePost", postId: "victim" }, { cookie: authorCookie }),
    );
    expect(expectData<ActionResult>(allowed).data.ok).toBe(true);
    row = await app.env.DB.prepare("SELECT deleted_at FROM posts WHERE id = 'victim'").first<{
      deleted_at: string | null;
    }>();
    expect(row?.deleted_at).not.toBeNull();
  });
});

describe("action envelope", () => {
  it("asks anonymous users to log in before rejecting an unknown intent", async () => {
    const result = await callAction(formRequest(URL_HOME, { intent: "hack" }));
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(401);
    expect(data.error).toBe("この操作にはログインが必要です。");
  });

  it("rejects unknown intents from logged-in users", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    const result = await callAction(formRequest(URL_HOME, { intent: "hack" }, { cookie }));
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(400);
    expect(data.error).toBe("不明な操作です。");
  });

  it("returns a friendly 500 when the body is not form data", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await callAction(malformedFormRequest(URL_HOME));
      const { data, status } = expectData<ActionResult>(result);
      expect(status).toBe(500);
      expect(data.error).toBe("問題が発生しました。時間をおいてもう一度お試しください。");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("maps handler crashes to a 500 tagged with the auth form", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = failingEnv(app.env, "SELECT id, handle, display_name, role, password_hash");
      const result = await callAction(
        formRequest(URL_HOME, { intent: "login", handle: "member", password: "secret pass 9" }),
        env,
      );
      const { data, status } = expectData<ActionResult>(result);
      expect(status).toBe(500);
      expect(data.form).toBe("login");
    } finally {
      consoleError.mockRestore();
    }
  });
});
