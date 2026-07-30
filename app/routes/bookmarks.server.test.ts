import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addReaction, createPost, createTestApp, createUser, failingEnv, resetData, type TestApp } from "../testing/d1";
import { expectData, expectRedirect, formRequest, getRequest, loginCookie, routeArgs } from "../testing/requests";
import { action, loader, MAX_BOOKMARK_PAGE } from "./bookmarks";

type ActionResult = { ok?: boolean; error?: string };
type LoaderResult = {
  user: { id: string };
  posts: { id: string }[];
  page: number;
  hasNextPage: boolean;
  bookmarksError: boolean;
};

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

const URL_BOOKMARKS = "http://test.local/bookmarks";

/** 固定の基準時刻。ブックマークの並び順を決めるのに使う。 */
const BASE_MS = Date.parse("2026-06-01T10:00:00Z");
const bookmarkedAt = (index: number) => new Date(BASE_MS + index * 60_000).toISOString();

/** ログイン済みの GET を撃ち、loader のデータを取り出す。 */
async function callLoader(url: string, cookie: string): Promise<LoaderResult> {
  const result = await loader(routeArgs(getRequest(url, { cookie }), app.env, { pattern: "/bookmarks" }));
  return expectData<LoaderResult>(result).data;
}

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

  it("20件ずつページングし、2ページ目で続きへ到達できる", async () => {
    const author = await createUser(app.env);
    const user = await createUser(app.env);
    // 21件ブックマークする（新しい順に並ぶよう created_at をずらす）。
    for (let index = 0; index < 21; index += 1) {
      const id = `bm_${String(index).padStart(2, "0")}`;
      await createPost(app.env, { id, authorId: author.id });
      await addReaction(app.env, { userId: user.id, postId: id, kind: "bookmark", createdAt: bookmarkedAt(index) });
    }
    const cookie = await loginCookie(app.env, user.id);

    const first = await callLoader(URL_BOOKMARKS, cookie);
    expect(first.page).toBe(1);
    expect(first.posts).toHaveLength(20);
    expect(first.hasNextPage).toBe(true);
    expect(first.posts[0].id).toBe("bm_20");

    const second = await callLoader(`${URL_BOOKMARKS}?page=2`, cookie);
    expect(second.page).toBe(2);
    expect(second.hasNextPage).toBe(false);
    // 101件目以降へ到達できなかった頃の回帰。1ページ目と中身が重ならないことも見る。
    expect(second.posts.map((post) => post.id)).toEqual(["bm_00"]);
  });

  it("壊れたページ番号は1ページ目に丸める", async () => {
    const author = await createUser(app.env);
    const user = await createUser(app.env);
    await createPost(app.env, { id: "only", authorId: author.id });
    await addReaction(app.env, { userId: user.id, postId: "only", kind: "bookmark" });
    const cookie = await loginCookie(app.env, user.id);

    for (const query of ["?page=abc", "?page=0", "?page=-4", ""]) {
      const result = await callLoader(`${URL_BOOKMARKS}${query}`, cookie);
      expect(result.page).toBe(1);
      expect(result.posts.map((post) => post.id)).toEqual(["only"]);
    }
  });

  it("ページ番号に上限を掛けて OFFSET を深く走らせない", async () => {
    // OFFSET は読み飛ばす行も走査されるため、上限が無いと `?page=99999` を並べるだけで
    // 読み取り負荷を際限なく増幅できる（loader は GET なのでレートリミットも掛からない）。
    const author = await createUser(app.env);
    const user = await createUser(app.env);
    for (let index = 0; index < 21; index += 1) {
      const id = `deep_${String(index).padStart(2, "0")}`;
      await createPost(app.env, { id, authorId: author.id });
      await addReaction(app.env, { userId: user.id, postId: id, kind: "bookmark", createdAt: bookmarkedAt(index) });
    }
    const cookie = await loginCookie(app.env, user.id);

    expect((await callLoader(URL_BOOKMARKS, cookie)).hasNextPage).toBe(true);

    for (const query of [`?page=${MAX_BOOKMARK_PAGE + 1}`, "?page=99999", "?page=9007199254740993"]) {
      const result = await callLoader(`${URL_BOOKMARKS}${query}`, cookie);
      expect(result.page).toBe(MAX_BOOKMARK_PAGE);
      // 上限ページでは「次へ」を出さない（押しても同じページに丸められるため）。
      expect(result.hasNextPage).toBe(false);
    }
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
