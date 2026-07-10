import type { AppEnv } from "../cloudflare";

export type TimelinePost = {
  id: string;
  authorId: string;
  name: string;
  handle: string;
  body: string;
  createdAt: string;
  replies: number;
  reposts: number;
  likes: number;
  liked: boolean;
  reposted: boolean;
  bookmarked: boolean;
};

type PostRow = {
  id: string;
  author_id: string;
  display_name: string;
  handle: string;
  body: string;
  created_at: string;
  replies: number;
  reposts: number;
  likes: number;
};

type ReactionRow = { post_id: string; kind: "like" | "repost" | "bookmark" };

export async function getTimeline(env: AppEnv, viewerId: string | null): Promise<TimelinePost[]> {
  const result = await env.DB.prepare(
    `SELECT p.id, p.author_id, u.display_name, u.handle, p.body, p.created_at,
       (SELECT COUNT(*) FROM posts replies WHERE replies.reply_to_id = p.id AND replies.deleted_at IS NULL) AS replies,
       (SELECT COUNT(*) FROM post_reactions rr WHERE rr.post_id = p.id AND rr.kind = 'repost') AS reposts,
       (SELECT COUNT(*) FROM post_reactions lr WHERE lr.post_id = p.id AND lr.kind = 'like') AS likes
     FROM posts p
     JOIN users u ON u.id = p.author_id
     WHERE p.deleted_at IS NULL AND p.visibility = 'public'
     ORDER BY p.created_at DESC
     LIMIT 50`,
  ).all<PostRow>();

  const rows = result.results ?? [];
  const reactions = new Map<string, Set<ReactionRow["kind"]>>();
  if (viewerId && rows.length > 0) {
    const placeholders = rows.map(() => "?").join(",");
    const reactionResult = await env.DB.prepare(
      `SELECT post_id, kind FROM post_reactions WHERE user_id = ? AND post_id IN (${placeholders})`,
    ).bind(viewerId, ...rows.map((row) => row.id)).all<ReactionRow>();
    for (const reaction of reactionResult.results ?? []) {
      const set = reactions.get(reaction.post_id) ?? new Set<ReactionRow["kind"]>();
      set.add(reaction.kind);
      reactions.set(reaction.post_id, set);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    authorId: row.author_id,
    name: row.display_name,
    handle: row.handle,
    body: row.body,
    createdAt: row.created_at,
    replies: Number(row.replies),
    reposts: Number(row.reposts),
    likes: Number(row.likes),
    liked: reactions.get(row.id)?.has("like") ?? false,
    reposted: reactions.get(row.id)?.has("repost") ?? false,
    bookmarked: reactions.get(row.id)?.has("bookmark") ?? false,
  }));
}
