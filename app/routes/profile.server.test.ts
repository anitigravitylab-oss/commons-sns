import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isFollowing } from "../lib/users.server";
import { addFollow, createPost, createTestApp, createUser, failingEnv, resetData, type TestApp } from "../testing/d1";
import {
  expectData,
  expectRedirect,
  formRequest,
  getRequest,
  loginCookie,
  malformedFormRequest,
  routeArgs,
} from "../testing/requests";
import { action, loader } from "./profile";

type ActionResult = { ok?: boolean; error?: string };

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

function callLoader(url: string, handle: string, cookie?: string, env = app.env) {
  return loader(routeArgs(getRequest(url, { cookie }), env, { pattern: "/users/:handle", params: { handle } }));
}

function callAction(handle: string, fields: Record<string, string>, cookie?: string, env = app.env) {
  return action(
    routeArgs(formRequest(`http://test.local/users/${handle}`, fields, { cookie }), env, {
      pattern: "/users/:handle",
      params: { handle },
    }),
  );
}

async function expectThrownStatus(promise: Promise<unknown>, status: number) {
  try {
    await promise;
  } catch (thrown) {
    expect(thrown).toMatchObject({ init: { status } });
    return;
  }
  throw new Error(`expected a thrown ${status} response`);
}

describe("profile loader", () => {
  it("throws a 404 for unknown handles", async () => {
    await expectThrownStatus(callLoader("http://test.local/users/ghost", "ghost"), 404);
  });

  it("resolves the profile case-insensitively and with a leading @", async () => {
    const user = await createUser(app.env, { handle: "someone" });
    const result = await callLoader("http://test.local/users/@Someone", "@Someone");
    expect(result.profile.id).toBe(user.id);
    expect(result.user).toBeNull();
    expect(result.viewerFollows).toBe(false);
  });

  it("pages posts twenty at a time with a look-ahead", async () => {
    const user = await createUser(app.env, { handle: "prolific" });
    for (let index = 0; index < 21; index += 1) {
      await createPost(app.env, {
        id: `pp_${String(index).padStart(2, "0")}`,
        authorId: user.id,
        createdAt: `2026-06-01 10:${String(index).padStart(2, "0")}:00`,
      });
    }

    const pageOne = await callLoader("http://test.local/users/prolific", "prolific");
    expect(pageOne.page).toBe(1);
    expect(pageOne.posts).toHaveLength(20);
    expect(pageOne.hasNextPage).toBe(true);
    expect(pageOne.posts[0].id).toBe("pp_20");

    const pageTwo = await callLoader("http://test.local/users/prolific?page=2", "prolific");
    expect(pageTwo.page).toBe(2);
    expect(pageTwo.posts).toHaveLength(1);
    expect(pageTwo.hasNextPage).toBe(false);
    expect(pageTwo.posts[0].id).toBe("pp_00");
  });

  it("normalizes hostile page parameters to page one", async () => {
    const user = await createUser(app.env, { handle: "paged" });
    await createPost(app.env, { authorId: user.id });

    for (const query of ["?page=abc", "?page=0", "?page=-4", ""]) {
      const result = await callLoader(`http://test.local/users/paged${query}`, "paged");
      expect(result.page).toBe(1);
      expect(result.posts).toHaveLength(1);
    }
  });

  it("reports whether the viewer follows the profile", async () => {
    const owner = await createUser(app.env, { handle: "owner" });
    const follower = await createUser(app.env);
    await addFollow(app.env, follower.id, owner.id);

    const cookie = await loginCookie(app.env, follower.id);
    const result = await callLoader("http://test.local/users/owner", "owner", cookie);
    expect(result.user?.id).toBe(follower.id);
    expect(result.viewerFollows).toBe(true);
    // The profile owner looking at their own page never "follows" themselves.
    const ownCookie = await loginCookie(app.env, owner.id);
    const own = await callLoader("http://test.local/users/owner", "owner", ownCookie);
    expect(own.viewerFollows).toBe(false);
  });

  it("flags a posts error while still rendering the profile header", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const user = await createUser(app.env, { handle: "flaky" });
      await createPost(app.env, { authorId: user.id });
      const env = failingEnv(app.env, "LIMIT ? OFFSET ?");
      const result = await callLoader("http://test.local/users/flaky", "flaky", undefined, env);
      expect(result.profile.id).toBe(user.id);
      expect(result.postsError).toBe(true);
      expect(result.posts).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("profile action", () => {
  it("redirects anonymous submissions to the login modal", async () => {
    await createUser(app.env, { handle: "target" });
    const result = await callAction("target", { intent: "toggleFollow" });
    expect(expectRedirect(result).location).toBe("/?auth=login");
  });

  it("throws a 404 when the profile vanished", async () => {
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    await expectThrownStatus(callAction("ghost", { intent: "toggleFollow" }, cookie), 404);
  });

  it("returns a friendly 500 when the body is not form data", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await createUser(app.env, { handle: "target" });
      const user = await createUser(app.env);
      const cookie = await loginCookie(app.env, user.id);
      const result = await action(
        routeArgs(malformedFormRequest("http://test.local/users/target", { cookie }), app.env, {
          pattern: "/users/:handle",
          params: { handle: "target" },
        }),
      );
      expect(expectData<ActionResult>(result).status).toBe(500);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects unknown intents", async () => {
    await createUser(app.env, { handle: "target" });
    const user = await createUser(app.env);
    const cookie = await loginCookie(app.env, user.id);
    const result = await callAction("target", { intent: "hack" }, cookie);
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(400);
    expect(data.error).toBe("不正な操作です。");
  });

  it("toggles a follow from the profile page", async () => {
    const owner = await createUser(app.env, { handle: "owner" });
    const visitor = await createUser(app.env);
    const cookie = await loginCookie(app.env, visitor.id);

    const followed = await callAction("owner", { intent: "toggleFollow" }, cookie);
    expect(expectData<ActionResult>(followed).data.ok).toBe(true);
    expect(await isFollowing(app.env, visitor.id, owner.id)).toBe(true);

    const unfollowed = await callAction("owner", { intent: "toggleFollow" }, cookie);
    expect(expectData<ActionResult>(unfollowed).data.ok).toBe(true);
    expect(await isFollowing(app.env, visitor.id, owner.id)).toBe(false);
  });

  it("refuses to follow yourself", async () => {
    const user = await createUser(app.env, { handle: "selfie" });
    const cookie = await loginCookie(app.env, user.id);
    const result = await callAction("selfie", { intent: "toggleFollow" }, cookie);
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(400);
    expect(data.error).toBe("自分をフォローすることはできません。");
  });

  it("maps a follow failure to a friendly 500", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await createUser(app.env, { handle: "owner" });
      const visitor = await createUser(app.env);
      const cookie = await loginCookie(app.env, visitor.id);
      const env = failingEnv(app.env, "DELETE FROM follows");
      const result = await callAction("owner", { intent: "toggleFollow" }, cookie, env);
      const { data, status } = expectData<ActionResult>(result);
      expect(status).toBe(500);
      expect(data.error).toBe("フォロー状態を変更できませんでした。");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("updates the owner's profile", async () => {
    const owner = await createUser(app.env, { handle: "editable" });
    const cookie = await loginCookie(app.env, owner.id);
    const result = await callAction(
      "editable",
      { intent: "updateProfile", displayName: "  改名しました  ", bio: "新しい自己紹介\nです" },
      cookie,
    );
    expect(expectData<ActionResult>(result).data.ok).toBe(true);

    const row = await app.env.DB.prepare("SELECT display_name, bio FROM users WHERE id = ?")
      .bind(owner.id)
      .first<{ display_name: string; bio: string }>();
    expect(row?.display_name).toBe("改名しました");
    expect(row?.bio).toBe("新しい自己紹介\nです");
  });

  it("forbids editing someone else's profile", async () => {
    await createUser(app.env, { handle: "victim", displayName: "被害者" });
    const attacker = await createUser(app.env);
    const cookie = await loginCookie(app.env, attacker.id);
    const result = await callAction("victim", { intent: "updateProfile", displayName: "乗っ取り", bio: "" }, cookie);
    const { data, status } = expectData<ActionResult>(result);
    expect(status).toBe(403);
    expect(data.error).toBe("このプロフィールは編集できません。");

    const row = await app.env.DB.prepare("SELECT display_name FROM users WHERE handle = 'victim'").first<{
      display_name: string;
    }>();
    expect(row?.display_name).toBe("被害者");
  });

  it("maps validation errors to localized 400 messages", async () => {
    const owner = await createUser(app.env, { handle: "picky" });
    const cookie = await loginCookie(app.env, owner.id);

    const badName = await callAction("picky", { intent: "updateProfile", displayName: "", bio: "" }, cookie);
    expect(expectData<ActionResult>(badName)).toMatchObject({
      status: 400,
      data: { error: "表示名は1〜30文字で入力してください。" },
    });

    const badBio = await callAction(
      "picky",
      { intent: "updateProfile", displayName: "有効な名前", bio: "い".repeat(161) },
      cookie,
    );
    expect(expectData<ActionResult>(badBio)).toMatchObject({
      status: 400,
      data: { error: "自己紹介は160文字以内で入力してください。" },
    });
  });

  it("maps an update failure to a friendly 500", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const owner = await createUser(app.env, { handle: "unlucky" });
      const cookie = await loginCookie(app.env, owner.id);
      const env = failingEnv(app.env, "UPDATE users SET display_name");
      const result = await callAction(
        "unlucky",
        { intent: "updateProfile", displayName: "新しい名前", bio: "" },
        cookie,
        env,
      );
      const { data, status } = expectData<ActionResult>(result);
      expect(status).toBe(500);
      expect(data.error).toBe("プロフィールを更新できませんでした。");
    } finally {
      consoleError.mockRestore();
    }
  });
});
