import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addFollow,
  createPost,
  createTestApp,
  createUser,
  failingEnv,
  rejectingEnv,
  resetData,
  type TestApp,
} from "../testing/d1";
import { BIO_MAX_LENGTH, DISPLAY_NAME_MAX_LENGTH } from "./profile-constraints";
import {
  createUserAccount,
  FOLLOW_LIST_PAGE_SIZE,
  hasLoginCapableAdmin,
  getFollowList,
  getUserProfileByHandle,
  MAX_FOLLOW_LIST_PAGE,
  isFollowing,
  ProfileValidationError,
  toggleFollow,
  updateUserProfile,
} from "./users.server";

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

describe("getUserProfileByHandle", () => {
  it("returns null for an unknown handle", async () => {
    expect(await getUserProfileByHandle(app.env, "nobody")).toBeNull();
  });

  it("returns the profile with public post and follow counts", async () => {
    const user = await createUser(app.env, {
      handle: "profiled",
      displayName: "プロフィール",
      bio: "自己紹介です",
      createdAt: "2026-01-15 09:30:00",
    });
    const fan = await createUser(app.env);
    const idol = await createUser(app.env);

    await createPost(app.env, { authorId: user.id });
    await createPost(app.env, { authorId: user.id });
    // Neither deleted nor followers-only posts count as public posts.
    await createPost(app.env, { authorId: user.id, deletedAt: "2026-01-01 00:00:00" });
    await createPost(app.env, { authorId: user.id, visibility: "followers" });
    await addFollow(app.env, fan.id, user.id);
    await addFollow(app.env, user.id, idol.id);

    const profile = await getUserProfileByHandle(app.env, "profiled");
    expect(profile).toEqual({
      id: user.id,
      handle: "profiled",
      displayName: "プロフィール",
      bio: "自己紹介です",
      avatarKey: null,
      role: "user",
      createdAt: "2026-01-15 09:30:00",
      postCount: 2,
      followerCount: 1,
      followingCount: 1,
    });
  });

  it("returns the stored preset avatar key", async () => {
    await createUser(app.env, { handle: "iconed", avatarKey: "preset:clover" });
    const profile = await getUserProfileByHandle(app.env, "iconed");
    expect(profile?.avatarKey).toBe("preset:clover");
  });

  it("matches handles case-insensitively", async () => {
    const user = await createUser(app.env, { handle: "mixedcase" });
    const profile = await getUserProfileByHandle(app.env, "MixedCase");
    expect(profile?.id).toBe(user.id);
    // The stored casing is what comes back, not the query casing.
    expect(profile?.handle).toBe("mixedcase");
  });
});

describe("createUserAccount", () => {
  const credentials = { passwordHash: "a".repeat(64), passwordSalt: "b".repeat(32) };

  it("creates a regular account", async () => {
    const result = await createUserAccount(app.env, { handle: "newbie", displayName: "新人", ...credentials });
    expect(result).toEqual({ ok: true, userId: expect.stringMatching(/^[0-9a-f-]{36}$/), promoted: false });

    const row = await app.env.DB.prepare("SELECT role FROM users WHERE handle = 'newbie'").first<{ role: string }>();
    expect(row).toEqual({ role: "user" });
  });

  it("reports a taken handle instead of throwing, ignoring case", async () => {
    await createUser(app.env, { handle: "taken" });
    const result = await createUserAccount(app.env, { handle: "TAKEN", displayName: "重複", ...credentials });
    expect(result).toEqual({ ok: false, reason: "handleTaken" });
  });

  it("rethrows failures that are not constraint violations", async () => {
    const env = failingEnv(app.env, "INSERT INTO users", "disk on fire");
    await expect(createUserAccount(env, { handle: "unlucky", displayName: "不運", ...credentials })).rejects.toThrow(
      "disk on fire",
    );

    // Error 以外で reject されても、メッセージ判定で落ちずにそのまま投げ直す。
    const oddEnv = rejectingEnv(app.env, "INSERT INTO users", "disk on fire");
    await expect(createUserAccount(oddEnv, { handle: "unlucky", displayName: "不運", ...credentials })).rejects.toBe(
      "disk on fire",
    );
  });

  it("promotes only the first account that asks for it", async () => {
    const owner = await createUserAccount(app.env, {
      handle: "owner1",
      displayName: "オーナー",
      promoteToAdmin: true,
      ...credentials,
    });
    expect(owner).toMatchObject({ ok: true, promoted: true });
    expect((await getUserProfileByHandle(app.env, "owner1"))?.role).toBe("admin");

    // 既にログインできる admin が居るので、2人目は昇格しない。
    const second = await createUserAccount(app.env, {
      handle: "owner2",
      displayName: "偽オーナー",
      promoteToAdmin: true,
      ...credentials,
    });
    expect(second).toMatchObject({ ok: true, promoted: false });
    expect((await getUserProfileByHandle(app.env, "owner2"))?.role).toBe("user");
  });

  it("ignores password-less seed admins when deciding whether to promote", async () => {
    // シードの公式アカウントは password 無しの admin。素の role 判定だと、
    // シードを流したインスタンスではブートストラップが永遠に発動しない。
    await createUser(app.env, { handle: "seed_admin", role: "admin", password: null });

    const owner = await createUserAccount(app.env, {
      handle: "owner3",
      displayName: "オーナー",
      promoteToAdmin: true,
      ...credentials,
    });
    expect(owner).toMatchObject({ ok: true, promoted: true });
    expect((await getUserProfileByHandle(app.env, "owner3"))?.role).toBe("admin");
  });

  it("hasLoginCapableAdmin はログインできる admin だけを数える", async () => {
    expect(await hasLoginCapableAdmin(app.env)).toBe(false);
    // シードの公式アカウント相当（パスワード無しの admin）は「居ない」と扱う。
    await createUser(app.env, { handle: "seed_admin", role: "admin", password: null });
    expect(await hasLoginCapableAdmin(app.env)).toBe(false);
    // 一般利用者も対象外。
    await createUser(app.env, { handle: "plain_user" });
    expect(await hasLoginCapableAdmin(app.env)).toBe(false);

    await createUser(app.env, { handle: "real_admin", role: "admin" });
    expect(await hasLoginCapableAdmin(app.env)).toBe(true);
  });

  it("never promotes unless the caller explicitly asks", async () => {
    await createUserAccount(app.env, { handle: "plain", displayName: "普通", ...credentials });
    await createUserAccount(app.env, {
      handle: "explicit",
      displayName: "明示",
      promoteToAdmin: false,
      ...credentials,
    });

    for (const handle of ["plain", "explicit"]) {
      expect((await getUserProfileByHandle(app.env, handle))?.role).toBe("user");
    }
  });
});

describe("isFollowing / toggleFollow", () => {
  it("toggles a follow on and off", async () => {
    const follower = await createUser(app.env);
    const followee = await createUser(app.env);

    expect(await isFollowing(app.env, follower.id, followee.id)).toBe(false);

    expect(await toggleFollow(app.env, follower.id, followee.id)).toEqual({ following: true });
    expect(await isFollowing(app.env, follower.id, followee.id)).toBe(true);
    // Follows are directional.
    expect(await isFollowing(app.env, followee.id, follower.id)).toBe(false);

    expect(await toggleFollow(app.env, follower.id, followee.id)).toEqual({ following: false });
    expect(await isFollowing(app.env, follower.id, followee.id)).toBe(false);

    expect(await toggleFollow(app.env, follower.id, followee.id)).toEqual({ following: true });
    expect(await isFollowing(app.env, follower.id, followee.id)).toBe(true);
  });

  it("does not create a follow towards a user that no longer exists", async () => {
    const follower = await createUser(app.env);
    const result = await toggleFollow(app.env, follower.id, "user_gone");
    // The EXISTS guard swallows the write and the reported state reflects it.
    expect(result).toEqual({ following: false });
    expect(await isFollowing(app.env, follower.id, "user_gone")).toBe(false);
  });

  it("rejects a self-follow at the database level", async () => {
    const user = await createUser(app.env);
    await expect(toggleFollow(app.env, user.id, user.id)).rejects.toThrow();
    expect(await isFollowing(app.env, user.id, user.id)).toBe(false);
  });
});

describe("getFollowList", () => {
  it("フォロー中とフォロワーを主キー順で返す", async () => {
    const viewer = await createUser(app.env, { id: "fl_viewer", handle: "fl_viewer" });
    const first = await createUser(app.env, { id: "fl_a", handle: "fl_a", displayName: "エー", bio: "自己紹介A" });
    const second = await createUser(app.env, { id: "fl_b", handle: "fl_b" });
    await addFollow(app.env, viewer.id, first.id);
    await addFollow(app.env, viewer.id, second.id);
    await addFollow(app.env, second.id, viewer.id);

    const following = await getFollowList(app.env, viewer.id, "following", viewer.id);
    expect(following.entries.map((entry) => entry.id)).toEqual(["fl_a", "fl_b"]);
    expect(following.entries[0]).toMatchObject({
      handle: "fl_a",
      displayName: "エー",
      bio: "自己紹介A",
      avatarKey: null,
      role: "user",
      viewerFollows: true,
    });
    expect(following.hasNextPage).toBe(false);

    const followers = await getFollowList(app.env, viewer.id, "followers", viewer.id);
    expect(followers.entries.map((entry) => entry.id)).toEqual(["fl_b"]);
    expect(followers.entries[0].viewerFollows).toBe(true);
  });

  it("フォロワーは新しい順（既存索引の順序）で返す", async () => {
    // followers 側の並びは follows_following_idx (following_id, created_at DESC) に
    // そのまま乗せる。索引で満たせない並びにすると、LIMIT の前に全フォロワーを
    // 集めて並べ替えることになり、公開ページの読み取りが総数に比例してしまう。
    const owner = await createUser(app.env, { id: "fo_owner", handle: "fo_owner" });
    const oldest = await createUser(app.env, { id: "fo_oldest", handle: "fo_oldest" });
    const middle = await createUser(app.env, { id: "fo_middle", handle: "fo_middle" });
    const newest = await createUser(app.env, { id: "fo_newest", handle: "fo_newest" });
    await addFollow(app.env, oldest.id, owner.id, { createdAt: "2026-06-01 10:00:00" });
    await addFollow(app.env, middle.id, owner.id, { createdAt: "2026-06-02 10:00:00" });
    await addFollow(app.env, newest.id, owner.id, { createdAt: "2026-06-03 10:00:00" });

    const followers = await getFollowList(app.env, owner.id, "followers", null);
    expect(followers.entries.map((entry) => entry.id)).toEqual(["fo_newest", "fo_middle", "fo_oldest"]);
  });

  it("閲覧者がフォローしていない相手には viewerFollows を立てない", async () => {
    const owner = await createUser(app.env, { id: "fl_owner", handle: "fl_owner" });
    const target = await createUser(app.env, { id: "fl_target", handle: "fl_target" });
    const guest = await createUser(app.env, { id: "fl_guest", handle: "fl_guest" });
    await addFollow(app.env, owner.id, target.id);

    const asGuest = await getFollowList(app.env, owner.id, "following", guest.id);
    expect(asGuest.entries[0].viewerFollows).toBe(false);

    // 未ログインでも一覧は見える（相互判定のクエリは撃たない）。
    const anonymous = await getFollowList(app.env, owner.id, "following", null);
    expect(anonymous.entries[0].viewerFollows).toBe(false);
  });

  it("ページングし、次ページの有無を返す", async () => {
    const owner = await createUser(app.env, { id: "fl_pager", handle: "fl_pager" });
    for (let index = 0; index < 3; index += 1) {
      const target = await createUser(app.env, { id: `fl_p${index}`, handle: `fl_p${index}` });
      await addFollow(app.env, owner.id, target.id);
    }

    const first = await getFollowList(app.env, owner.id, "following", null, { limit: 2 });
    expect(first.entries.map((entry) => entry.id)).toEqual(["fl_p0", "fl_p1"]);
    expect(first.hasNextPage).toBe(true);

    const second = await getFollowList(app.env, owner.id, "following", null, { limit: 2, offset: 2 });
    expect(second.entries.map((entry) => entry.id)).toEqual(["fl_p2"]);
    expect(second.hasNextPage).toBe(false);
  });

  it("誰もいない一覧と、範囲外の指定を安全に扱う", async () => {
    const lonely = await createUser(app.env);
    expect(await getFollowList(app.env, lonely.id, "followers", lonely.id)).toEqual({
      entries: [],
      hasNextPage: false,
    });
    expect(
      (await getFollowList(app.env, lonely.id, "following", null, { limit: 0, offset: -10 })).entries,
    ).toHaveLength(0);
    expect(
      (await getFollowList(app.env, lonely.id, "following", null, { limit: 1_000, offset: Number.NaN })).entries,
    ).toHaveLength(0);
    expect(FOLLOW_LIST_PAGE_SIZE).toBeGreaterThan(0);
    expect(MAX_FOLLOW_LIST_PAGE).toBeGreaterThan(0);
  });
});

describe("updateUserProfile", () => {
  it("saves the sanitized display name and bio", async () => {
    const user = await createUser(app.env);
    await updateUserProfile(app.env, user.id, {
      displayName: "  新しい名前\u200b  ",
      bio: "一行目\r\n二行目",
    });

    const row = await app.env.DB.prepare("SELECT display_name, bio FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ display_name: string; bio: string }>();
    expect(row?.display_name).toBe("新しい名前");
    // Newlines survive in the bio; carriage returns do not.
    expect(row?.bio).toBe("一行目\n二行目");
  });

  it("accepts boundary lengths, counting by code points", async () => {
    const user = await createUser(app.env);
    const name = "😀".repeat(DISPLAY_NAME_MAX_LENGTH);
    const bio = "あ".repeat(BIO_MAX_LENGTH);
    await updateUserProfile(app.env, user.id, { displayName: name, bio });

    const row = await app.env.DB.prepare("SELECT display_name, bio FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ display_name: string; bio: string }>();
    expect(row?.display_name).toBe(name);
    expect(row?.bio).toBe(bio);
  });

  it("rejects a display name that is empty after sanitizing", async () => {
    const user = await createUser(app.env);
    await expect(updateUserProfile(app.env, user.id, { displayName: " \u200b ", bio: "" })).rejects.toThrow(
      ProfileValidationError,
    );
    await expect(updateUserProfile(app.env, user.id, { displayName: " \u200b ", bio: "" })).rejects.toMatchObject({
      code: "displayNameLength",
      name: "ProfileValidationError",
    });
  });

  it("rejects a display name over the limit", async () => {
    const user = await createUser(app.env);
    await expect(
      updateUserProfile(app.env, user.id, { displayName: "あ".repeat(DISPLAY_NAME_MAX_LENGTH + 1), bio: "" }),
    ).rejects.toMatchObject({ code: "displayNameLength" });
  });

  it("rejects a bio over the limit and leaves the row untouched", async () => {
    const user = await createUser(app.env, { displayName: "元の名前", bio: "元の自己紹介" });
    await expect(
      updateUserProfile(app.env, user.id, { displayName: "新しい名前", bio: "い".repeat(BIO_MAX_LENGTH + 1) }),
    ).rejects.toMatchObject({ code: "bioLength" });

    const row = await app.env.DB.prepare("SELECT display_name, bio FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ display_name: string; bio: string }>();
    expect(row?.display_name).toBe("元の名前");
    expect(row?.bio).toBe("元の自己紹介");
  });

  async function storedAvatarKey(userId: string) {
    const row = await app.env.DB.prepare("SELECT avatar_key FROM users WHERE id = ?")
      .bind(userId)
      .first<{ avatar_key: string | null }>();
    return row?.avatar_key ?? null;
  }

  it("saves a preset avatar key and clears it back to the default", async () => {
    const user = await createUser(app.env);
    await updateUserProfile(app.env, user.id, { displayName: "名前", bio: "", avatarKey: "preset:clover" });
    expect(await storedAvatarKey(user.id)).toBe("preset:clover");

    await updateUserProfile(app.env, user.id, { displayName: "名前", bio: "", avatarKey: null });
    expect(await storedAvatarKey(user.id)).toBeNull();
  });

  it("leaves the avatar untouched when avatarKey is not part of the update", async () => {
    const user = await createUser(app.env, { avatarKey: "preset:moon" });
    await updateUserProfile(app.env, user.id, { displayName: "改名", bio: "本文" });
    expect(await storedAvatarKey(user.id)).toBe("preset:moon");
  });

  it("rejects unknown avatar keys and never writes them", async () => {
    const user = await createUser(app.env, { avatarKey: "preset:clover" });
    for (const avatarKey of ["clover", "preset:unknown", "avatars/evil.png", "preset:"]) {
      await expect(
        updateUserProfile(app.env, user.id, { displayName: "名前", bio: "", avatarKey }),
      ).rejects.toMatchObject({ code: "avatarKey", name: "ProfileValidationError" });
    }
    expect(await storedAvatarKey(user.id)).toBe("preset:clover");
  });
});
