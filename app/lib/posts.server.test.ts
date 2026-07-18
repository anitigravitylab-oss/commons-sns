import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addFollow, addReaction, createPost, createTestApp, createUser, resetData, type TestApp } from "../testing/d1";
import { getBookmarkedPosts, getTimeline, getUserPosts } from "./posts.server";

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

/** Zero-padded timestamps a fixed number of minutes apart, oldest first. */
function minutesAgo(minutes: number) {
  return `2026-06-01 ${String(11 - Math.floor(minutes / 60)).padStart(2, "0")}:${String(59 - (minutes % 60)).padStart(2, "0")}:00`;
}

describe("getTimeline (recommended)", () => {
  it("returns public, non-deleted posts newest first with author identity", async () => {
    const alice = await createUser(app.env, { handle: "alice", displayName: "アリス" });
    const bob = await createUser(app.env, { handle: "bob", displayName: "ボブ" });

    await createPost(app.env, { id: "p_old", authorId: alice.id, body: "古い投稿", createdAt: minutesAgo(30) });
    await createPost(app.env, { id: "p_new", authorId: bob.id, body: "新しい投稿", createdAt: minutesAgo(5) });
    await createPost(app.env, { id: "p_del", authorId: alice.id, deletedAt: minutesAgo(1), createdAt: minutesAgo(2) });
    await createPost(app.env, { id: "p_fol", authorId: alice.id, visibility: "followers", createdAt: minutesAgo(3) });

    const timeline = await getTimeline(app.env, null);
    expect(timeline.map((post) => post.id)).toEqual(["p_new", "p_old"]);
    expect(timeline[0]).toMatchObject({
      id: "p_new",
      authorId: bob.id,
      name: "ボブ",
      handle: "bob",
      body: "新しい投稿",
      createdAt: minutesAgo(5),
      liked: false,
      reposted: false,
      bookmarked: false,
    });
  });

  it("breaks created_at ties by descending id", async () => {
    const user = await createUser(app.env);
    const at = minutesAgo(10);
    await createPost(app.env, { id: "tie_a", authorId: user.id, createdAt: at });
    await createPost(app.env, { id: "tie_b", authorId: user.id, createdAt: at });
    await createPost(app.env, { id: "tie_c", authorId: user.id, createdAt: at });

    const timeline = await getTimeline(app.env, null);
    expect(timeline.map((post) => post.id)).toEqual(["tie_c", "tie_b", "tie_a"]);
  });

  it("counts likes, reposts and non-deleted replies", async () => {
    const author = await createUser(app.env);
    const reader = await createUser(app.env);
    const other = await createUser(app.env);
    await createPost(app.env, { id: "counted", authorId: author.id, createdAt: minutesAgo(60) });

    await addReaction(app.env, { userId: reader.id, postId: "counted", kind: "like" });
    await addReaction(app.env, { userId: other.id, postId: "counted", kind: "like" });
    await addReaction(app.env, { userId: reader.id, postId: "counted", kind: "repost" });
    // Bookmarks are private and never aggregated into public counts.
    await addReaction(app.env, { userId: reader.id, postId: "counted", kind: "bookmark" });
    await createPost(app.env, { authorId: reader.id, replyToId: "counted", createdAt: minutesAgo(50) });
    await createPost(app.env, {
      authorId: other.id,
      replyToId: "counted",
      createdAt: minutesAgo(40),
      deletedAt: minutesAgo(30),
    });

    const timeline = await getTimeline(app.env, null);
    const counted = timeline.find((post) => post.id === "counted");
    expect(counted).toMatchObject({ likes: 2, reposts: 1, replies: 1 });
  });

  it("marks the viewer's own reactions across more than one lookup batch", async () => {
    const author = await createUser(app.env);
    const viewer = await createUser(app.env);

    // 55 posts forces two reaction-lookup batches (50 + 5).
    for (let index = 0; index < 55; index += 1) {
      await createPost(app.env, {
        id: `bulk_${String(index).padStart(2, "0")}`,
        authorId: author.id,
        createdAt: minutesAgo(110 - index),
      });
    }
    await addReaction(app.env, { userId: viewer.id, postId: "bulk_54", kind: "like" });
    await addReaction(app.env, { userId: viewer.id, postId: "bulk_00", kind: "bookmark" });
    await addReaction(app.env, { userId: viewer.id, postId: "bulk_30", kind: "repost" });

    const timeline = await getTimeline(app.env, viewer.id);
    expect(timeline).toHaveLength(50);
    const byId = new Map(timeline.map((post) => [post.id, post]));
    expect(byId.get("bulk_54")).toMatchObject({ liked: true, reposted: false, bookmarked: false });
    expect(byId.get("bulk_30")).toMatchObject({ reposted: true, liked: false });
    // bulk_00 fell off the 50-post window entirely.
    expect(byId.has("bulk_00")).toBe(false);
  });

  it("caps the timeline at 50 posts", async () => {
    const user = await createUser(app.env);
    for (let index = 0; index < 55; index += 1) {
      await createPost(app.env, {
        id: `cap_${String(index).padStart(2, "0")}`,
        authorId: user.id,
        createdAt: minutesAgo(110 - index),
      });
    }
    const timeline = await getTimeline(app.env, null);
    expect(timeline).toHaveLength(50);
    expect(timeline[0].id).toBe("cap_54");
    expect(timeline[49].id).toBe("cap_05");
  });
});

describe("getTimeline (following)", () => {
  it("returns an empty list for anonymous viewers", async () => {
    const user = await createUser(app.env);
    await createPost(app.env, { authorId: user.id });
    expect(await getTimeline(app.env, null, "following")).toEqual([]);
  });

  it("shows only the viewer's and followed users' posts", async () => {
    const viewer = await createUser(app.env);
    const followed = await createUser(app.env);
    const stranger = await createUser(app.env);
    await addFollow(app.env, viewer.id, followed.id);

    await createPost(app.env, { id: "own", authorId: viewer.id, createdAt: minutesAgo(3) });
    await createPost(app.env, { id: "theirs", authorId: followed.id, createdAt: minutesAgo(2) });
    await createPost(app.env, { id: "noise", authorId: stranger.id, createdAt: minutesAgo(1) });

    const timeline = await getTimeline(app.env, viewer.id, "following");
    expect(timeline.map((post) => post.id)).toEqual(["theirs", "own"]);
  });
});

describe("getBookmarkedPosts", () => {
  it("returns only the user's bookmarks, ordered by bookmark time", async () => {
    const author = await createUser(app.env);
    const user = await createUser(app.env);
    const other = await createUser(app.env);

    // Post age and bookmark age intentionally disagree: the list follows
    // when the bookmark was made, not when the post was written.
    await createPost(app.env, { id: "bm_old_post", authorId: author.id, createdAt: minutesAgo(100) });
    await createPost(app.env, { id: "bm_new_post", authorId: author.id, createdAt: minutesAgo(5) });
    await addReaction(app.env, { userId: user.id, postId: "bm_old_post", kind: "bookmark", createdAt: minutesAgo(1) });
    await addReaction(app.env, { userId: user.id, postId: "bm_new_post", kind: "bookmark", createdAt: minutesAgo(4) });
    // Likes and other users' bookmarks must not leak in.
    await createPost(app.env, { id: "bm_liked", authorId: author.id, createdAt: minutesAgo(6) });
    await addReaction(app.env, { userId: user.id, postId: "bm_liked", kind: "like" });
    await addReaction(app.env, { userId: other.id, postId: "bm_liked", kind: "bookmark" });

    const bookmarks = await getBookmarkedPosts(app.env, user.id);
    expect(bookmarks.map((post) => post.id)).toEqual(["bm_old_post", "bm_new_post"]);
    expect(bookmarks[0].bookmarked).toBe(true);
  });

  it("hides bookmarked posts that were deleted or made followers-only", async () => {
    const author = await createUser(app.env);
    const user = await createUser(app.env);
    await createPost(app.env, { id: "bm_gone", authorId: author.id, deletedAt: minutesAgo(1) });
    await createPost(app.env, { id: "bm_private", authorId: author.id, visibility: "followers" });
    await addReaction(app.env, { userId: user.id, postId: "bm_gone", kind: "bookmark" });
    await addReaction(app.env, { userId: user.id, postId: "bm_private", kind: "bookmark" });

    expect(await getBookmarkedPosts(app.env, user.id)).toEqual([]);
  });
});

describe("getUserPosts", () => {
  it("returns only the author's public posts", async () => {
    const author = await createUser(app.env);
    const other = await createUser(app.env);
    await createPost(app.env, { id: "mine", authorId: author.id, createdAt: minutesAgo(3) });
    await createPost(app.env, { id: "deleted", authorId: author.id, deletedAt: minutesAgo(1) });
    await createPost(app.env, { id: "private", authorId: author.id, visibility: "followers" });
    await createPost(app.env, { id: "someone_elses", authorId: other.id });

    const posts = await getUserPosts(app.env, author.id, null);
    expect(posts.map((post) => post.id)).toEqual(["mine"]);
  });

  it("pages through posts with limit and offset", async () => {
    const author = await createUser(app.env);
    for (let index = 0; index < 5; index += 1) {
      await createPost(app.env, {
        id: `page_${index}`,
        authorId: author.id,
        createdAt: minutesAgo(10 - index),
      });
    }

    const pageOne = await getUserPosts(app.env, author.id, null, { limit: 2, offset: 0 });
    const pageTwo = await getUserPosts(app.env, author.id, null, { limit: 2, offset: 2 });
    const pageThree = await getUserPosts(app.env, author.id, null, { limit: 2, offset: 4 });
    expect(pageOne.map((post) => post.id)).toEqual(["page_4", "page_3"]);
    expect(pageTwo.map((post) => post.id)).toEqual(["page_2", "page_1"]);
    expect(pageThree.map((post) => post.id)).toEqual(["page_0"]);
  });

  it("clamps hostile limit and offset values instead of failing", async () => {
    const author = await createUser(app.env);
    for (let index = 0; index < 3; index += 1) {
      await createPost(app.env, { id: `clamp_${index}`, authorId: author.id, createdAt: minutesAgo(10 - index) });
    }

    // limit 0 and negatives clamp up to a single row.
    expect(await getUserPosts(app.env, author.id, null, { limit: 0 })).toHaveLength(1);
    expect(await getUserPosts(app.env, author.id, null, { limit: -7 })).toHaveLength(1);
    // Oversized limits clamp down to 100 (all three rows here).
    expect(await getUserPosts(app.env, author.id, null, { limit: 100_000 })).toHaveLength(3);
    // Negative offsets clamp to the start; fractional values are truncated.
    expect((await getUserPosts(app.env, author.id, null, { offset: -5 }))[0].id).toBe("clamp_2");
    expect(await getUserPosts(app.env, author.id, null, { limit: 2.9, offset: 0.4 })).toHaveLength(2);
  });

  it("treats a NaN offset as the first page", async () => {
    const author = await createUser(app.env);
    await createPost(app.env, { id: "nan_offset", authorId: author.id });
    const posts = await getUserPosts(app.env, author.id, null, { offset: Number.NaN });
    expect(posts.map((post) => post.id)).toEqual(["nan_offset"]);
  });

  it("returns an empty page without a reaction lookup when the author has no posts", async () => {
    const author = await createUser(app.env);
    const viewer = await createUser(app.env);
    expect(await getUserPosts(app.env, author.id, viewer.id)).toEqual([]);
  });

  it("hydrates the viewer's reactions", async () => {
    const author = await createUser(app.env);
    const viewer = await createUser(app.env);
    await createPost(app.env, { id: "reacted", authorId: author.id });
    await addReaction(app.env, { userId: viewer.id, postId: "reacted", kind: "like" });
    await addReaction(app.env, { userId: viewer.id, postId: "reacted", kind: "bookmark" });

    const [post] = await getUserPosts(app.env, author.id, viewer.id);
    expect(post).toMatchObject({ id: "reacted", liked: true, bookmarked: true, reposted: false, likes: 1 });
  });
});
