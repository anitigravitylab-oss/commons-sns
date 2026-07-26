import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_LIMITS, consumeToken, resetRateLimits } from "../lib/rate-limit.server";
import { MAX_FOLLOW_LIST_PAGE as SERVER_MAX_FOLLOW_LIST_PAGE, isFollowing } from "../lib/users.server";
import { addFollow, countingEnv, createTestApp, createUser, failingEnv, resetData, type TestApp } from "../testing/d1";
import {
  expectData,
  expectRedirect,
  formRequest,
  getRequest,
  loginCookie,
  malformedFormRequest,
  routeArgs,
} from "../testing/requests";
import { MAX_FOLLOW_LIST_PAGE, action, loader } from "./follow-list";

type ActionResult = { ok?: boolean; error?: string };
type LoaderResult = {
  user: { id: string } | null;
  profile: { id: string; handle: string };
  kind: "following" | "followers";
  page: number;
  entries: { id: string; handle: string; viewerFollows: boolean }[];
  hasNextPage: boolean;
  listError: boolean;
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
  resetRateLimits();
});

const FOLLOWING_PATTERN = "/users/:handle/following";
const FOLLOWERS_PATTERN = "/users/:handle/followers";

/** 一覧ルートの loader を呼ぶ（種別は URL の末尾で決まる）。 */
function listArgs(handle: string, kind: "following" | "followers", options: { cookie?: string; query?: string } = {}) {
  const url = `http://test.local/users/${handle}/${kind}${options.query ?? ""}`;
  return routeArgs(getRequest(url, { cookie: options.cookie }), app.env, {
    pattern: kind === "following" ? FOLLOWING_PATTERN : FOLLOWERS_PATTERN,
    params: { handle },
  });
}

describe("MAX_FOLLOW_LIST_PAGE", () => {
  it("サーバー側の定義と食い違わない", () => {
    // ルート側は clientLoader からも読むため、サーバー専用モジュールから import できない。
    // 2つの定義がずれるとキャッシュキーとページャの上限が食い違うので、ここで固定する。
    expect(MAX_FOLLOW_LIST_PAGE).toBe(SERVER_MAX_FOLLOW_LIST_PAGE);
  });
});

describe("follow-list loader", () => {
  it("存在しないハンドルは 404 にする", async () => {
    await expect(loader(listArgs("nobody", "followers"))).rejects.toMatchObject({ init: { status: 404 } });
  });

  it("`.data` 付きの URL でも種別を取り違えない", async () => {
    // クライアント遷移では React Router が `/users/x/following.data?_routes=following`
    // を取りに行く。パス末尾の素の比較だと種別が followers に落ち、URL だけ変わって
    // 中身が変わらないという症状になる（実際に e2e で踏んだ）。
    const owner = await createUser(app.env, { handle: "owner" });
    const target = await createUser(app.env, { handle: "target" });
    const follower = await createUser(app.env, { handle: "follower" });
    await addFollow(app.env, owner.id, target.id);
    await addFollow(app.env, follower.id, owner.id);

    const dataRequest = (kind: "following" | "followers") =>
      routeArgs(getRequest(`http://test.local/users/owner/${kind}.data?_routes=${kind}`), app.env, {
        pattern: kind === "following" ? FOLLOWING_PATTERN : FOLLOWERS_PATTERN,
        params: { handle: "owner" },
      });

    const following = expectData<LoaderResult>(await loader(dataRequest("following"))).data;
    expect(following.kind).toBe("following");
    expect(following.entries.map((entry) => entry.handle)).toEqual(["target"]);

    const followers = expectData<LoaderResult>(await loader(dataRequest("followers"))).data;
    expect(followers.kind).toBe("followers");
    expect(followers.entries.map((entry) => entry.handle)).toEqual(["follower"]);
  });

  it("末尾スラッシュ付きの URL でも種別を取り違えない", async () => {
    // `/users/x/following/` もこのルートにマッチする（実測で 200）。素の endsWith だと
    // 「フォロワー」と誤判定し、URL と中身が食い違う。
    const owner = await createUser(app.env, { handle: "owner" });
    const target = await createUser(app.env, { handle: "target" });
    const follower = await createUser(app.env, { handle: "follower" });
    await addFollow(app.env, owner.id, target.id);
    await addFollow(app.env, follower.id, owner.id);

    const slashed = (kind: "following" | "followers") =>
      routeArgs(getRequest(`http://test.local/users/owner/${kind}/`), app.env, {
        pattern: kind === "following" ? FOLLOWING_PATTERN : FOLLOWERS_PATTERN,
        params: { handle: "owner" },
      });

    const following = expectData<LoaderResult>(await loader(slashed("following"))).data;
    expect(following.kind).toBe("following");
    expect(following.entries.map((entry) => entry.handle)).toEqual(["target"]);

    const followers = expectData<LoaderResult>(await loader(slashed("followers"))).data;
    expect(followers.kind).toBe("followers");
    expect(followers.entries.map((entry) => entry.handle)).toEqual(["follower"]);
  });

  it("フォロー中の一覧を返し、未ログインでも読める", async () => {
    const owner = await createUser(app.env, { handle: "owner" });
    const a = await createUser(app.env, { handle: "target_a" });
    const b = await createUser(app.env, { handle: "target_b" });
    await addFollow(app.env, owner.id, a.id);
    await addFollow(app.env, owner.id, b.id);

    const { data } = expectData<LoaderResult>(await loader(listArgs("owner", "following")));
    expect(data.user).toBeNull();
    expect(data.kind).toBe("following");
    expect(data.profile.handle).toBe("owner");
    expect(data.entries.map((entry) => entry.handle).sort()).toEqual(["target_a", "target_b"]);
    // 未ログインの閲覧者には相互判定を撃たないので、常に false。
    expect(data.entries.every((entry) => entry.viewerFollows === false)).toBe(true);
    expect(data.hasNextPage).toBe(false);
    expect(data.listError).toBe(false);
  });

  it("フォロワーの一覧を返し、閲覧者のフォロー状態を反映する", async () => {
    const owner = await createUser(app.env, { handle: "owner" });
    const viewer = await createUser(app.env, { handle: "viewer" });
    const other = await createUser(app.env, { handle: "other" });
    await addFollow(app.env, viewer.id, owner.id);
    await addFollow(app.env, other.id, owner.id);
    // 閲覧者は other をフォロー済み（自分自身はフォローできない）。
    await addFollow(app.env, viewer.id, other.id);

    const cookie = await loginCookie(app.env, viewer.id);
    const { data } = expectData<LoaderResult>(await loader(listArgs("owner", "followers", { cookie })));
    expect(data.kind).toBe("followers");
    expect(data.user?.id).toBe(viewer.id);
    const byHandle = new Map(data.entries.map((entry) => [entry.handle, entry.viewerFollows]));
    expect(byHandle.get("other")).toBe(true);
    expect(byHandle.get("viewer")).toBe(false);
  });

  it("ページ番号を正規化し、上限を超えたページでは次へを出さない", async () => {
    const owner = await createUser(app.env, { handle: "owner" });
    for (let index = 0; index < 22; index += 1) {
      const target = await createUser(app.env, { handle: `follow_${index.toString().padStart(2, "0")}` });
      await addFollow(app.env, owner.id, target.id);
    }

    const first = expectData<LoaderResult>(await loader(listArgs("owner", "following"))).data;
    expect(first.page).toBe(1);
    expect(first.entries).toHaveLength(20);
    expect(first.hasNextPage).toBe(true);

    const second = expectData<LoaderResult>(await loader(listArgs("owner", "following", { query: "?page=2" }))).data;
    expect(second.page).toBe(2);
    expect(second.entries).toHaveLength(2);
    expect(second.hasNextPage).toBe(false);

    // OFFSET 走査の頭打ち。壊れた page 指定は 1 ページ目に丸める。
    const clamped = expectData<LoaderResult>(
      await loader(listArgs("owner", "following", { query: "?page=9999" })),
    ).data;
    expect(clamped.page).toBe(25);
    const negative = expectData<LoaderResult>(await loader(listArgs("owner", "following", { query: "?page=-3" }))).data;
    expect(negative.page).toBe(1);
  });

  it("一覧の取得に失敗してもプロフィールごと落とさない", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const owner = await createUser(app.env, { handle: "owner" });
      const target = await createUser(app.env, { handle: "target" });
      await addFollow(app.env, owner.id, target.id);
      const env = failingEnv(app.env, "FROM follows f JOIN users");
      const result = await loader(
        routeArgs(getRequest("http://test.local/users/owner/following"), env, {
          pattern: FOLLOWING_PATTERN,
          params: { handle: "owner" },
        }),
      );
      const { data } = expectData<LoaderResult>(result);
      expect(data.listError).toBe(true);
      expect(data.entries).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("follow-list action", () => {
  const followUrl = "http://test.local/users/owner/followers";

  it("未ログインはログインへ誘導する", async () => {
    const result = await action(
      routeArgs(formRequest(followUrl, { intent: "toggleFollow", targetId: "someone" }), app.env, {
        pattern: FOLLOWERS_PATTERN,
        params: { handle: "owner" },
      }),
    );
    expect(expectRedirect(result).location).toBe("/?auth=login");
  });

  it("一覧の行からフォローと解除ができる", async () => {
    const viewer = await createUser(app.env);
    const target = await createUser(app.env);
    const cookie = await loginCookie(app.env, viewer.id);
    const args = () =>
      routeArgs(formRequest(followUrl, { intent: "toggleFollow", targetId: target.id }, { cookie }), app.env, {
        pattern: FOLLOWERS_PATTERN,
        params: { handle: "owner" },
      });

    expect(expectData<ActionResult>(await action(args())).data.ok).toBe(true);
    expect(await isFollowing(app.env, viewer.id, target.id)).toBe(true);
    expect(expectData<ActionResult>(await action(args())).data.ok).toBe(true);
    expect(await isFollowing(app.env, viewer.id, target.id)).toBe(false);
  });

  it("自分自身のフォローと未知の intent を拒む", async () => {
    const viewer = await createUser(app.env);
    const cookie = await loginCookie(app.env, viewer.id);
    const send = (fields: Record<string, string>) =>
      action(
        routeArgs(formRequest(followUrl, fields, { cookie }), app.env, {
          pattern: FOLLOWERS_PATTERN,
          params: { handle: "owner" },
        }),
      );

    const self = expectData<ActionResult>(await send({ intent: "toggleFollow", targetId: viewer.id }));
    expect(self.status).toBe(400);
    expect(self.data.error).toContain("自分をフォロー");

    const unknown = expectData<ActionResult>(await send({ intent: "explode", targetId: "x" }));
    expect(unknown.status).toBe(400);
    const missing = expectData<ActionResult>(await send({ intent: "toggleFollow", targetId: "  " }));
    expect(missing.status).toBe(400);
  });

  it("壊れたフォーム本文を 500 として扱う", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const viewer = await createUser(app.env);
      const cookie = await loginCookie(app.env, viewer.id);
      const result = await action(
        routeArgs(malformedFormRequest(followUrl, { cookie }), app.env, {
          pattern: FOLLOWERS_PATTERN,
          params: { handle: "owner" },
        }),
      );
      expect(expectData<ActionResult>(result).status).toBe(500);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("別サイトからの送信は 403、本文が大きすぎる送信は 413", async () => {
    const viewer = await createUser(app.env);
    const cookie = await loginCookie(app.env, viewer.id);
    const send = (options: { origin?: string; contentLength?: number }) =>
      action(
        routeArgs(
          formRequest(followUrl, { intent: "toggleFollow", targetId: "someone" }, { cookie, ...options }),
          app.env,
          {
            pattern: FOLLOWERS_PATTERN,
            params: { handle: "owner" },
          },
        ),
      );

    expect(((await send({ origin: "https://evil.example" })) as Response).status).toBe(403);
    expect(expectData<ActionResult>(await send({ contentLength: 1_048_576 })).status).toBe(413);
  });

  it("フォローの書き込みが失敗したらエラーを返す", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const viewer = await createUser(app.env);
      const target = await createUser(app.env);
      const cookie = await loginCookie(app.env, viewer.id);
      const env = failingEnv(app.env, "DELETE FROM follows");
      const result = await action(
        routeArgs(formRequest(followUrl, { intent: "toggleFollow", targetId: target.id }, { cookie }), env, {
          pattern: FOLLOWERS_PATTERN,
          params: { handle: "owner" },
        }),
      );
      const { data, status } = expectData<ActionResult>(result);
      expect(status).toBe(500);
      expect(data.error).toContain("フォロー状態");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("フォローのレートリミットを共有する", async () => {
    const viewer = await createUser(app.env);
    const target = await createUser(app.env);
    const cookie = await loginCookie(app.env, viewer.id);
    // プロフィール側と同じ `follow` バケツを使う（枠を二重に持たない）。
    for (let index = 0; index < RATE_LIMITS.follow.capacity; index += 1) consumeToken("follow", viewer.id);

    const result = await action(
      routeArgs(formRequest(followUrl, { intent: "toggleFollow", targetId: target.id }, { cookie }), app.env, {
        pattern: FOLLOWERS_PATTERN,
        params: { handle: "owner" },
      }),
    );
    expect(expectData<ActionResult>(result).status).toBe(429);
    expect(await isFollowing(app.env, viewer.id, target.id)).toBe(false);
  });
});

/**
 * 索引が意図どおり使われていることを rows_read で固定する。
 *
 * `follows` の主キー／`follows_following_idx` を引けている限り、読み取り行数は
 * 「表示件数＋フォロー関係の件数」程度で頭打ちになる。索引が外れると
 * 登録者総数に比例した全走査になる。
 */
describe("follow-list の rows_read", () => {
  it("フォロワー一覧20件の読み取り行数が登録者総数に依存しない", async () => {
    const owner = await createUser(app.env, { handle: "owner" });
    const viewer = await createUser(app.env, { handle: "viewer" });
    // 一覧に出ない利用者・フォロー関係を大量に混ぜても読み取り行数は変わらないこと。
    for (let index = 0; index < 40; index += 1) {
      const follower = await createUser(app.env, { handle: `f_${index.toString().padStart(2, "0")}` });
      await addFollow(app.env, follower.id, owner.id);
      await addFollow(app.env, follower.id, viewer.id);
    }

    const cookie = await loginCookie(app.env, viewer.id);
    const counter = countingEnv(app.env);
    const result = await loader(
      routeArgs(getRequest("http://test.local/users/owner/followers", { cookie }), counter.env, {
        pattern: FOLLOWERS_PATTERN,
        params: { handle: "owner" },
      }),
    );
    expect(expectData<LoaderResult>(result).data.entries).toHaveLength(20);
    // プロフィールヘッダ（COUNT サブクエリ含む）＋ セッション照合 ＋ 一覧 20 件 ＋
    // 相互判定 1 クエリで実測 166 行。上限はそこへ少し余裕を持たせた値で、
    // 索引が外れて全走査になると登録者数に比例して跳ね上がるのを検知する。
    expect(counter.rowsRead()).toBeLessThanOrEqual(200);
  });
});
