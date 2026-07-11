import type { AppEnv } from "../cloudflare";
import { BIO_MAX_LENGTH, DISPLAY_NAME_MAX_LENGTH, DISPLAY_NAME_MIN_LENGTH } from "./profile-constraints";

export type UserProfile = {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  role: "user" | "moderator" | "admin";
  createdAt: string;
  postCount: number;
  followerCount: number;
  followingCount: number;
};

type UserProfileRow = {
  id: string;
  handle: string;
  display_name: string;
  bio: string;
  role: UserProfile["role"];
  created_at: string;
  post_count: number;
  follower_count: number;
  following_count: number;
};

export async function getUserProfileByHandle(env: AppEnv, handle: string): Promise<UserProfile | null> {
  const row = await env.DB.prepare(
    `SELECT
       u.id,
       u.handle,
       u.display_name,
       u.bio,
       u.role,
       u.created_at,
       (SELECT COUNT(*) FROM posts p WHERE p.author_id = u.id AND p.deleted_at IS NULL AND p.visibility = 'public') AS post_count,
       (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id) AS follower_count,
       (SELECT COUNT(*) FROM follows f WHERE f.follower_id = u.id) AS following_count
     FROM users u
     WHERE u.handle = ? COLLATE NOCASE
     LIMIT 1`,
  )
    .bind(handle)
    .first<UserProfileRow>();

  if (!row) return null;
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    bio: row.bio,
    role: row.role,
    createdAt: row.created_at,
    postCount: Number(row.post_count),
    followerCount: Number(row.follower_count),
    followingCount: Number(row.following_count),
  };
}

export async function updateUserProfile(env: AppEnv, userId: string, values: { displayName: string; bio: string }) {
  const displayName = values.displayName.trim();
  const bio = values.bio.trim();
  if (displayName.length < DISPLAY_NAME_MIN_LENGTH || displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new Error("displayName must be between 1 and 30 characters");
  }
  if (bio.length > BIO_MAX_LENGTH) {
    throw new Error("bio must be 160 characters or fewer");
  }

  await env.DB.prepare("UPDATE users SET display_name = ?, bio = ? WHERE id = ?").bind(displayName, bio, userId).run();
}
