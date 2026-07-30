import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeToken, RATE_LIMITS, resetRateLimits } from "../lib/rate-limit.server";
import { addReaction, createPost, createTestApp, createUser, failingEnv, resetData, type TestApp } from "../testing/d1";
import { expectData, expectRedirect, formRequest, getRequest, loginCookie, routeArgs } from "../testing/requests";
import { action, loader } from "./bookmarks";

type ActionResult = { ok?: boolean; error?: string };
type LoaderResult = { user: { id: string }; posts: { id: string }[]; bookmarksError: boolean };

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

const URL_BOOKMARKS = "http://test.local/bookmarks";

describe("bookmarks loader", () => {
  it("redirects anonymous visitors to the login modal", async () => {
    const result = await loader(routeArgs(getRequest(URL_BOOKMARKS), app.env, { pattern: "/bookmarks" }));
    expect(expectRedirect(result).location).toBe("/?auth=login");
  });

  it("lists the user's bookmarked posts", async () => {
    const author = await createUser(app.env);
    const user = await createUser(app.env);
    await createPost(app.env, { id: "kept", authorId: author.id });
    await createPost(app.env, { id: "ignored", authorId: author.id });
    await addReaction(app.env, { userId: user.id, postId: "kept", kind: "bookmark" });

    const cookie = await loginCookie(app.env, user.id);
    const result = await loader(routeArgs(getRequest(URL_BOOKMARKS, { cookie }), app.env, { pattern: "/bookmarks" }));
    const { data } = expectData<LoaderResult>(result);
    expect(data.user.id).toBe(user.id);
    expect(data.bookmarksError).toBe(false);
    expect(data.posts.map((post) => post.id)).toEqual(["kept"]);
  });

  it("flags an error instead of crashing when the bookmark query fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const user = await createUser(app.env);
      const cookie = await loginCookie(app.env, user.id);
      // The session lookup succeeds; only the bookmark listing explodes.
      const env = failingEnv(app.env, "FROM post_reactions bookmark");
      const result = await loader(routeArgs(getRequest(URL_BOOKMARKS, { cookie }), env, { pattern: "/bookmarks" }));
      const { data } = expectData<LoaderResult>(result);
      expect(data.bookmarksError).toBe(true);
      expect(data.posts).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("bookmarks action", () => {
  it("redirects anonymous submissions to the login modal", async () => {
    const result = await action(
      routeArgs(formRequest(URL_BOOKMARKS, { intent: "removeBookmark", postId: "x" }), app.env, {
        pattern: "/bookmarks",
      }),
    );
    expect(expectRedirect(result).location).toBe("/?auth=login");
  });

  it("removes only the bookmark reaction for that post", async () => {
    const author = await createUser(app.env);
    const user = await createUser(app.env);
    await createPost(app.env, { id: "kept", authorId: author.id });
    await addReaction(app.env, { userId: user.id, postId: "kept", kind: "bookmark" });
    await addReaction(app.env, { userId: user.id, postId: "kept", kind: "like" });

    const cookie = await loginCookie(app.env, user.id);
    const result = await action(
      routeArgs(formRequest(URL_BOOKMARKS, { intent: "removeBookmark", postId: "kept" }, { cookie }), app.env, {
        pattern: "/bookmarks",
      }),
    );
    expect(expectData<ActionResult>(result).data.ok).toBe(true);

    const rows = await app.env.DB.prepare("SELECT kind FROM post_reactions WHERE user_id = ?").bind(user.id).all();
    expect(rows.results).toEqual([{ kind: "like" }]);
  });

  it("rejects unknown intents and missing post ids", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);

    const attempts: Record<string, string>[] = [{ intent: "hack", postId: "x" }, { intent: "removeBookmark" }];
    for (const fields of attempts) {
      const result = await action(
        routeArgs(formRequest(URL_BOOKMARKS, fields, { cookie }), app.env, { pattern: "/bookmarks" }),
      );
      const { data, status } = expectData<ActionResult>(result);
      expect(status).toBe(400);
      expect(data.error).toBe("不正な操作です。");
    }
  });

  it("別サイトからの送信は 403、本文が大きすぎる送信は 413", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    const send = (options: { origin?: string; contentLength?: number }) =>
      action(
        routeArgs(
          formRequest(URL_BOOKMARKS, { intent: "removeBookmark", postId: "x" }, { cookie, ...options }),
          app.env,
          { pattern: "/bookmarks" },
        ),
      );

    expect(((await send({ origin: "https://evil.example" })) as Response).status).toBe(403);
    expect(expectData<ActionResult>(await send({ contentLength: 1_048_576 })).status).toBe(413);
  });

  it("maps a failing delete to a 500 with a friendly message", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const user = await createUser(app.env);
      const cookie = await loginCookie(app.env, user.id);
      const env = failingEnv(app.env, "DELETE FROM post_reactions");
      const result = await action(
        routeArgs(formRequest(URL_BOOKMARKS, { intent: "removeBookmark", postId: "x" }, { cookie }), env, {
          pattern: "/bookmarks",
        }),
      );
      const { data, status } = expectData<ActionResult>(result);
      expect(status).toBe(500);
      expect(data.error).toBe("ブックマークを解除できませんでした。");
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("bookmarks rate limits", () => {
  it("stops a burst of bookmark removals with 429 and keeps the reaction", async () => {
    const author = await createUser(app.env);
    const user = await createUser(app.env);
    await createPost(app.env, { id: "kept", authorId: author.id });
    await addReaction(app.env, { userId: user.id, postId: "kept", kind: "bookmark" });
    const cookie = await loginCookie(app.env, user.id);
    // ブックマーク解除はリアクションと同じ枠を使う。
    for (let index = 0; index < RATE_LIMITS.reaction.capacity; index += 1) consumeToken("reaction", user.id);

    const result = await action(
      routeArgs(formRequest(URL_BOOKMARKS, { intent: "removeBookmark", postId: "kept" }, { cookie }), app.env, {
        pattern: "/bookmarks",
      }),
    );
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(429);
    expect(data.error).toBe("操作が多すぎます。しばらく待ってからお試しください。");

    const rows = await app.env.DB.prepare("SELECT kind FROM post_reactions WHERE user_id = ?").bind(user.id).all();
    expect(rows.results).toEqual([{ kind: "bookmark" }]);
  });
});
