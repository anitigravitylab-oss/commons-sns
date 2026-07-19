import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addFollow, createPost, createTestApp, createUser, resetData, type TestApp } from "../testing/d1";
import { BIO_MAX_LENGTH, DISPLAY_NAME_MAX_LENGTH } from "./profile-constraints";
import {
  getUserProfileByHandle,
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
      role: "user",
      createdAt: "2026-01-15 09:30:00",
      postCount: 2,
      followerCount: 1,
      followingCount: 1,
    });
  });

  it("matches handles case-insensitively", async () => {
    const user = await createUser(app.env, { handle: "mixedcase" });
    const profile = await getUserProfileByHandle(app.env, "MixedCase");
    expect(profile?.id).toBe(user.id);
    // The stored casing is what comes back, not the query casing.
    expect(profile?.handle).toBe("mixedcase");
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
});
