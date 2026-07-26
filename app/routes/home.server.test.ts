import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionUser, SESSION_COOKIE, verifyPassword } from "../lib/auth.server";
import { consumeToken, RATE_LIMITS, resetRateLimits } from "../lib/rate-limit.server";
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
  // レートリミットは isolate メモリに残るのでテスト間で持ち越さない。
  resetRateLimits();
});

const URL_HOME = "http://test.local/?index";

function callAction(request: Request, env = app.env) {
  return action(routeArgs(request, env, { pattern: "/" }));
}

/** `data()` の init から `Retry-After` を取り出す。 */
function retryAfterOf(result: unknown): string | null {
  const init = (result as { init?: ResponseInit | null }).init ?? null;
  return new Headers(init?.headers).get("Retry-After");
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

  it("ブートストラップ設定中に D1 が落ちても、縮退表示のまま 500 にしない", async () => {
    // 判定用のクエリを try の外に置くと、この経路が全画面 500（ルートの
    // ErrorBoundary）に化ける。設定を有効にしただけで復旧可能な障害が
    // 致命的な障害に変わってしまう。
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = { ...brokenEnv(), ADMIN_BOOTSTRAP_CODE: "launch-code" } as unknown as typeof app.env;
      const result = await callLoader(getRequest("http://test.local/"), env);
      expect(result.timelineError).toBe(true);
      expect(result.posts).toEqual([]);
      // 判定できないときは「欄を出さない」に倒す（成立済みでも出てしまうのを防ぐ）。
      expect(result.adminBootstrapOpen).toBe(false);
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

  it("別サイトからの送信は 403 で落とす（ログイン CSRF の遮断）", async () => {
    const user = await createUser(app.env, { handle: "csrf_target", password: "correct horse battery" });
    expect(user.id).toBeTruthy();

    // 攻撃者のサイトから、攻撃者の資格情報で被害者をログインさせようとする送信。
    const result = await callAction(
      formRequest(
        URL_HOME,
        { intent: "login", handle: "csrf_target", password: "correct horse battery" },
        { origin: "https://evil.example" },
      ),
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    // セッションは張られない。
    expect((result as Response).headers.get("Set-Cookie")).toBeNull();
  });

  it("Sec-Fetch-Site: cross-site も 403 で落とす", async () => {
    const result = await callAction(formRequest(URL_HOME, { intent: "logout" }, { secFetchSite: "cross-site" }));

    expect((result as Response).status).toBe(403);
  });

  it("同一 origin の送信と、ヘッダを持たない送信は通す", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);

    // 同一 origin（ブラウザからの通常の送信）。
    const sameOrigin = await callAction(
      formRequest(URL_HOME, { intent: "createPost", body: "同一 origin" }, { cookie, origin: "http://test.local" }),
    );
    expect(expectData<ActionResult>(sameOrigin).data.ok).toBe(true);

    // 判定材料が無い送信（テスト・curl・古いクライアント）はこれまでどおり通す。
    const noHeaders = await callAction(formRequest(URL_HOME, { intent: "createPost", body: "ヘッダ無し" }, { cookie }));
    expect(expectData<ActionResult>(noHeaders).data.ok).toBe(true);
  });

  it("本文が大きすぎる送信は読まずに 413", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    // 100MB を申告する（Cloudflare Free のリクエストボディ上限）。
    const request = formRequest(
      URL_HOME,
      { intent: "createPost", body: "巨大" },
      { cookie, contentLength: 100 * 1_024 * 1_024 },
    );

    const { data, status } = expectData<ActionResult>(await callAction(request));

    expect(status).toBe(413);
    expect(data.error).toBe("送信内容が大きすぎます。");
    // formData() を呼ぶと本文が isolate のヒープへ載る。門番はその前に効いていなければ意味がない。
    expect(request.bodyUsed).toBe(false);
    const posts = await app.env.DB.prepare("SELECT COUNT(*) AS n FROM posts").first<{ n: number }>();
    expect(posts?.n).toBe(0);
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

describe("invite code", () => {
  const signupFields = { intent: "signup", handle: "invited", displayName: "招待", password: "password123" };
  /** INVITE_CODE を設定した env。シークレットなので `vars` ではなく実行時に生える。 */
  const gatedEnv = () => ({ ...app.env, INVITE_CODE: "  open-sesame  " });

  it("tells the client whether the signup form needs an invite field", async () => {
    expect((await callLoader(getRequest("http://test.local/"))).inviteRequired).toBe(false);
    expect((await callLoader(getRequest("http://test.local/"), gatedEnv())).inviteRequired).toBe(true);
  });

  it("rejects a missing or wrong code with 403 while the gate is on", async () => {
    for (const inviteCode of ["", "wrong-code", "Open-Sesame"]) {
      const result = await callAction(formRequest(URL_HOME, { ...signupFields, inviteCode }), gatedEnv());
      const { data, status } = expectData<ActionResult>(result);
      expect(status).toBe(403);
      expect(data.form).toBe("signup");
      expect(data.error).toBe("招待コードが正しくありません。");
    }
    const row = await app.env.DB.prepare("SELECT COUNT(*) AS total FROM users").first<{ total: number }>();
    expect(row?.total).toBe(0);
  });

  it("creates the account when the code matches, ignoring surrounding whitespace", async () => {
    const result = await callAction(
      formRequest(URL_HOME, { ...signupFields, inviteCode: " open-sesame " }),
      gatedEnv(),
    );
    expect(expectRedirect(result).location).toBe("/");
  });

  it("ignores the field entirely while the gate is off", async () => {
    const result = await callAction(formRequest(URL_HOME, { ...signupFields, inviteCode: "nonsense" }));
    expect(expectRedirect(result).location).toBe("/");
  });
});

describe("初期管理者ブートストラップ（ADMIN_BOOTSTRAP_CODE）", () => {
  const fields = { intent: "signup", handle: "founder", displayName: "運営", password: "password123" };
  /** ブートストラップコードを設定した env。シークレットなので実行時にだけ生える。 */
  const bootstrapEnv = () => ({ ...app.env, ADMIN_BOOTSTRAP_CODE: "  launch-code  " }) as unknown as typeof app.env;

  it("コードが未設定なら、誰も admin に昇格しない", async () => {
    // 【重要】ハンドル名では認可しない。設定ファイルに書く値は公開リポジトリに載り
    // 推測もできるため、「特定のハンドルで登録した人を admin にする」方式では
    // 運営者より先に第三者が名乗るだけでインスタンスを乗っ取れてしまう。
    expect((await callLoader(getRequest("http://test.local/"))).adminBootstrapOpen).toBe(false);

    const result = await callAction(formRequest(URL_HOME, { ...fields, adminBootstrapCode: "anything" }));
    expect(expectData<ActionResult>(result).status).toBe(403);
    const row = await app.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("正しいコードを提示した最初の登録だけが admin になる", async () => {
    expect((await callLoader(getRequest("http://test.local/"), bootstrapEnv())).adminBootstrapOpen).toBe(true);

    const result = await callAction(
      formRequest(URL_HOME, { ...fields, adminBootstrapCode: " launch-code " }),
      bootstrapEnv(),
    );
    expect(expectRedirect(result).location).toBe("/");
    const row = await app.env.DB.prepare("SELECT role FROM users WHERE handle = 'founder'").first<{ role: string }>();
    expect(row?.role).toBe("admin");

    // 成立後は入力欄そのものが消え、同じコードでも2人目は昇格しない。
    expect((await callLoader(getRequest("http://test.local/"), bootstrapEnv())).adminBootstrapOpen).toBe(false);
    await callAction(
      formRequest(URL_HOME, { ...fields, handle: "second", adminBootstrapCode: "launch-code" }),
      bootstrapEnv(),
    );
    const second = await app.env.DB.prepare("SELECT role FROM users WHERE handle = 'second'").first<{ role: string }>();
    expect(second?.role).toBe("user");
  });

  it("コード欄が空の通常の登録は、これまでどおり一般利用者になる", async () => {
    const result = await callAction(formRequest(URL_HOME, fields), bootstrapEnv());
    expect(expectRedirect(result).location).toBe("/");
    const row = await app.env.DB.prepare("SELECT role FROM users WHERE handle = 'founder'").first<{ role: string }>();
    expect(row?.role).toBe("user");
  });

  it("誤ったコードは 403 で弾き、アカウントも作らない", async () => {
    for (const adminBootstrapCode of ["wrong", "Launch-Code"]) {
      const result = await callAction(formRequest(URL_HOME, { ...fields, adminBootstrapCode }), bootstrapEnv());
      const { data, status } = expectData<ActionResult>(result);
      expect(status).toBe(403);
      expect(data.error).toBe("管理者コードが正しくありません。");
    }
    const row = await app.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("パスワード無しのシード admin は成立済みとみなさない", async () => {
    // シードの公式アカウントは admin だがログインできないので、ブートストラップは開いたまま。
    await createUser(app.env, { handle: "seed_admin", role: "admin", password: null });

    expect((await callLoader(getRequest("http://test.local/"), bootstrapEnv())).adminBootstrapOpen).toBe(true);
    await callAction(formRequest(URL_HOME, { ...fields, adminBootstrapCode: "launch-code" }), bootstrapEnv());
    const row = await app.env.DB.prepare("SELECT role FROM users WHERE handle = 'founder'").first<{ role: string }>();
    expect(row?.role).toBe("admin");
  });

  it("予約語ハンドルはブートストラップでも免除しない", async () => {
    const result = await callAction(
      formRequest(URL_HOME, { ...fields, handle: "admin", adminBootstrapCode: "launch-code" }),
      bootstrapEnv(),
    );
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(400);
    expect(data.error).toBe("このIDは使用できません。");
  });
});

describe("rate limits", () => {
  const signupFields = { intent: "signup", displayName: "新人", password: "password123" };

  it("stops a burst of signups from one client with 429 and Retry-After", async () => {
    for (let index = 0; index < RATE_LIMITS.signup.capacity; index += 1) {
      const allowed = await callAction(formRequest(URL_HOME, { ...signupFields, handle: `newcomer${index}` }));
      expect(expectRedirect(allowed).location).toBe("/");
    }

    const blocked = await callAction(formRequest(URL_HOME, { ...signupFields, handle: "newcomer_last" }));
    const { data, status } = expectData<ActionResult>(blocked);
    expect(status).toBe(429);
    expect(data.form).toBe("signup");
    expect(data.error).toBe("操作が多すぎます。しばらく待ってからお試しください。");
    expect(Number(retryAfterOf(blocked))).toBeGreaterThan(0);
    const row = await app.env.DB.prepare("SELECT COUNT(*) AS total FROM users").first<{ total: number }>();
    expect(row?.total).toBe(RATE_LIMITS.signup.capacity);
  });

  it("stops brute-forced logins before the password is verified", async () => {
    await createUser(app.env, { handle: "member", password: "secret pass 9" });
    for (let index = 0; index < RATE_LIMITS.login.capacity; index += 1) consumeToken("login", "unknown");

    const result = await callAction(
      formRequest(URL_HOME, { intent: "login", handle: "member", password: "secret pass 9" }),
    );
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(429);
    expect(data.form).toBe("login");
    expect(retryAfterOf(result)).not.toBeNull();
  });

  it("stops a flood of posts from one account", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    for (let index = 0; index < RATE_LIMITS.post.capacity; index += 1) consumeToken("post", user.id);

    const result = await callAction(formRequest(URL_HOME, { intent: "createPost", body: "連投" }, { cookie }));
    expect(expectData<ActionResult>(result).status).toBe(429);
    const row = await app.env.DB.prepare("SELECT COUNT(*) AS total FROM posts").first<{ total: number }>();
    expect(row?.total).toBe(0);
  });

  it("shares one bucket between reactions and deletions", async () => {
    const user = await createUser(app.env);
    const post = await createPost(app.env, { authorId: user.id });
    const cookie = await loginCookie(app.env, user.id);
    for (let index = 0; index < RATE_LIMITS.reaction.capacity; index += 1) consumeToken("reaction", user.id);

    const reaction = await callAction(
      formRequest(URL_HOME, { intent: "toggleReaction", postId: post.id, kind: "like" }, { cookie }),
    );
    expect(expectData<ActionResult>(reaction).status).toBe(429);

    const deletion = await callAction(formRequest(URL_HOME, { intent: "deletePost", postId: post.id }, { cookie }));
    expect(expectData<ActionResult>(deletion).status).toBe(429);

    const row = await app.env.DB.prepare("SELECT deleted_at FROM posts WHERE id = ?")
      .bind(post.id)
      .first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).toBeNull();
  });
});
