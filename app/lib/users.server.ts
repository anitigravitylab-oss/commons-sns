import type { AppEnv } from "../cloudflare";
import { BIO_MAX_LENGTH, DISPLAY_NAME_MAX_LENGTH, DISPLAY_NAME_MIN_LENGTH } from "./profile-constraints";
import { countCodePoints, sanitizeText } from "./text";

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

export type ProfileValidationErrorCode = "displayNameLength" | "bioLength";

const PROFILE_VALIDATION_MESSAGES: Record<ProfileValidationErrorCode, string> = {
  displayNameLength: `displayName must be between ${DISPLAY_NAME_MIN_LENGTH} and ${DISPLAY_NAME_MAX_LENGTH} characters`,
  bioLength: `bio must be ${BIO_MAX_LENGTH} characters or fewer`,
};

export class ProfileValidationError extends Error {
  readonly code: ProfileValidationErrorCode;

  constructor(code: ProfileValidationErrorCode) {
    super(PROFILE_VALIDATION_MESSAGES[code]);
    this.name = "ProfileValidationError";
    this.code = code;
  }
}

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

export async function isFollowing(env: AppEnv, followerId: string, followingId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS present FROM follows WHERE follower_id = ? AND following_id = ?")
    .bind(followerId, followingId)
    .first<{ present: number }>();
  return row !== null;
}

/**
 * Follows the target user when no follow exists, otherwise unfollows.
 *
 * @returns The follow state after the toggle.
 */
export async function toggleFollow(
  env: AppEnv,
  followerId: string,
  followingId: string,
): Promise<{ following: boolean }> {
  const deleted = await env.DB.prepare("DELETE FROM follows WHERE follower_id = ? AND following_id = ?")
    .bind(followerId, followingId)
    .run();
  if ((deleted.meta.changes ?? 0) > 0) return { following: false };

  // The EXISTS guard keeps a follow of a just-deleted account from failing the
  // whole request; ON CONFLICT absorbs a concurrent duplicate toggle.
  await env.DB.prepare(
    `INSERT INTO follows (follower_id, following_id)
     SELECT ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
     ON CONFLICT (follower_id, following_id) DO NOTHING`,
  )
    .bind(followerId, followingId, followingId)
    .run();
  return { following: true };
}

/**
 * Sanitizes and updates a user's display name and bio.
 *
 * @param values - The display name and bio to save.
 * @throws `ProfileValidationError` if the display name is shorter than the minimum length or longer than the maximum length, or if the bio exceeds its allowed length.
 */
export async function updateUserProfile(env: AppEnv, userId: string, values: { displayName: string; bio: string }) {
  const displayName = sanitizeText(values.displayName);
  const bio = sanitizeText(values.bio, { multiline: true });
  const displayNameLength = countCodePoints(displayName, DISPLAY_NAME_MAX_LENGTH);
  if (displayNameLength < DISPLAY_NAME_MIN_LENGTH || displayNameLength > DISPLAY_NAME_MAX_LENGTH) {
    throw new ProfileValidationError("displayNameLength");
  }
  if (countCodePoints(bio, BIO_MAX_LENGTH) > BIO_MAX_LENGTH) {
    throw new ProfileValidationError("bioLength");
  }

  await env.DB.prepare("UPDATE users SET display_name = ?, bio = ? WHERE id = ?").bind(displayName, bio, userId).run();
}
