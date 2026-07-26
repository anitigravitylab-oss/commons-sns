import type { AppEnv } from "../cloudflare";
import { presetAvatarIdFromKey } from "./avatar-constraints";
import { BIO_MAX_LENGTH, DISPLAY_NAME_MAX_LENGTH, DISPLAY_NAME_MIN_LENGTH } from "./profile-constraints";
import { countCodePoints, sanitizeText } from "./text";

export type UserProfile = {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  avatarKey: string | null;
  role: "user" | "moderator" | "admin";
  createdAt: string;
  postCount: number;
  followerCount: number;
  followingCount: number;
};

export type ProfileValidationErrorCode = "displayNameLength" | "bioLength" | "avatarKey";

const PROFILE_VALIDATION_MESSAGES: Record<ProfileValidationErrorCode, string> = {
  displayNameLength: `displayName must be between ${DISPLAY_NAME_MIN_LENGTH} and ${DISPLAY_NAME_MAX_LENGTH} characters`,
  bioLength: `bio must be ${BIO_MAX_LENGTH} characters or fewer`,
  avatarKey: "avatarKey must be a known preset avatar key",
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
  avatar_key: string | null;
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
       u.avatar_key,
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
    avatarKey: row.avatar_key,
    role: row.role,
    createdAt: row.created_at,
    postCount: Number(row.post_count),
    followerCount: Number(row.follower_count),
    followingCount: Number(row.following_count),
  };
}

/**
 * ログインできる admin が存在するか（初期管理者ブートストラップの成立判定）。
 *
 * シードの公式アカウントはパスワード無しの admin なので、素の role 判定では
 * 「管理者としてログインする手段が無いのに成立済み」と誤判定してしまう。
 */
export async function hasLoginCapableAdmin(env: AppEnv): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS present FROM users WHERE role = 'admin' AND password_hash IS NOT NULL LIMIT 1",
  ).first<{ present: number }>();
  return row !== null;
}

export type CreateUserResult =
  | {
      ok: true;
      userId: string;
      /** admin へ昇格したか（＝このアカウントでブートストラップが成立したか）。 */
      promoted: boolean;
    }
  | { ok: false; reason: "handleTaken" };

/**
 * アカウントを作成する。
 *
 * `promoteToAdmin` が真で、かつ**ログインできる** admin が1人も居ないときだけ
 * role を `admin` にする（初期管理者のブートストラップ）。呼び出し側は、
 * シークレットのブートストラップコードを検証したうえでこのフラグを立てること
 * （`app/lib/invite.server.ts` の `verifyAdminBootstrapCode`）。
 *
 * 「ログインできる」で絞るのは、シードの公式アカウントがパスワード無しの admin
 * だから。素の `role = 'admin'` 判定だと、シードを流したインスタンスでは
 * ブートストラップが永遠に発動しない。
 */
export async function createUserAccount(
  env: AppEnv,
  values: {
    handle: string;
    displayName: string;
    passwordHash: string;
    passwordSalt: string;
    /** シークレットのコードを検証済みのときだけ true にする。既定は false。 */
    promoteToAdmin?: boolean;
  },
): Promise<CreateUserResult> {
  const wantsAdmin = values.promoteToAdmin === true;
  const userId = crypto.randomUUID();
  try {
    // 昇格の判定は INSERT と同じ文の中で行う（別クエリで確かめてから書くと、
    // その隙間に他の管理者が確立されうる）。RETURNING で実際に入った role を受け取る。
    const inserted = await env.DB.prepare(
      `INSERT INTO users (id, handle, display_name, password_hash, password_salt, role)
       SELECT ?, ?, ?, ?, ?,
              CASE WHEN ? = 1 AND NOT EXISTS (
                     SELECT 1 FROM users WHERE role = 'admin' AND password_hash IS NOT NULL
                   )
                   THEN 'admin' ELSE 'user' END
       RETURNING role`,
    )
      .bind(userId, values.handle, values.displayName, values.passwordHash, values.passwordSalt, wantsAdmin ? 1 : 0)
      .first<{ role: string }>();
    return { ok: true, userId, promoted: inserted?.role === "admin" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 「ID がすでに使われている」と言えるのは handle の一意制約に当たったときだけ。
    // 制約違反をまとめて丸めると、主キー衝突や CHECK 違反まで利用者へ誤報してしまう。
    if (/UNIQUE constraint failed:\s*users\.handle/i.test(message)) return { ok: false, reason: "handleTaken" };
    throw error;
  }
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
  const inserted = await env.DB.prepare(
    `INSERT INTO follows (follower_id, following_id)
     SELECT ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
     ON CONFLICT (follower_id, following_id) DO NOTHING`,
  )
    .bind(followerId, followingId, followingId)
    .run();
  if ((inserted.meta.changes ?? 0) > 0) return { following: true };
  // Nothing was written: the target vanished (no follow) or a concurrent
  // duplicate toggle already inserted the row — report what is stored.
  return { following: await isFollowing(env, followerId, followingId) };
}

export type FollowListKind = "following" | "followers";

export type FollowListEntry = {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  avatarKey: string | null;
  role: UserProfile["role"];
  /** 閲覧者がこの相手をフォローしているか（未ログインなら false） */
  viewerFollows: boolean;
};

/** フォロー一覧の1ページあたり件数。 */
export const FOLLOW_LIST_PAGE_SIZE = 20;
/** フォロー一覧の最大ページ番号（OFFSET 走査の頭打ち）。`app/routes/follow-list.tsx` と揃える。 */
export const MAX_FOLLOW_LIST_PAGE = 25;

type FollowListRow = {
  id: string;
  handle: string;
  display_name: string;
  bio: string;
  avatar_key: string | null;
  role: UserProfile["role"];
};

/**
 * フォロー中／フォロワーの一覧を取得する。
 *
 * 並びは**既存の索引がそのまま提供できる順序**に合わせる。索引で満たせない ORDER BY を
 * 書くと、SQLite は LIMIT を掛ける前に該当行を全部集めて並べ替えるため、公開ページの
 * 1リクエストがそのユーザーのフォロー関係の総数に比例してしまう。
 *
 * - following: 主キー `(follower_id, following_id)` を先頭一致で走査 → `following_id` 昇順
 * - followers: `follows_following_idx (following_id, created_at DESC)` を走査 → 新しい順
 *
 * followers 側の `created_at` は秒精度なので、同秒のフォローが続くと OFFSET の境界で
 * 行が重複・欠落しうる。並べ替え列を足して安定させると索引で順序を満たせなくなるので、
 * まれな表示ゆらぎのほうを受け入れる。
 *
 * 相互表示（フォローボタンの初期状態）は、取得した相手 ID を1クエリでまとめて引く
 * （バインドは 1 + ページ件数 = 最大 91 個で、D1 の上限 100 に収まる）。
 */
export async function getFollowList(
  env: AppEnv,
  profileUserId: string,
  kind: FollowListKind,
  viewerId: string | null,
  options: { limit?: number; offset?: number } = {},
): Promise<{ entries: FollowListEntry[]; hasNextPage: boolean }> {
  // 取得件数は 90 で頭打ちにする。相互判定の `IN (?,…)` に ID をそのまま並べるので、
  // 「閲覧者 1 + 件数」が D1 のバインド変数上限 100 を超えてはいけない。
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? FOLLOW_LIST_PAGE_SIZE), 1), 90);
  const requestedOffset = Math.trunc(options.offset ?? 0);
  const offset = Number.isNaN(requestedOffset) ? 0 : Math.max(requestedOffset, 0);

  const sql =
    kind === "following"
      ? `SELECT u.id, u.handle, u.display_name, u.bio, u.avatar_key, u.role
           FROM follows f JOIN users u ON u.id = f.following_id
          WHERE f.follower_id = ?
          ORDER BY f.following_id
          LIMIT ? OFFSET ?`
      : `SELECT u.id, u.handle, u.display_name, u.bio, u.avatar_key, u.role
           FROM follows f JOIN users u ON u.id = f.follower_id
          WHERE f.following_id = ?
          ORDER BY f.created_at DESC
          LIMIT ? OFFSET ?`;

  const result = await env.DB.prepare(sql)
    .bind(profileUserId, limit + 1, offset)
    .all<FollowListRow>();
  const rows = result.results ?? [];
  const hasNextPage = rows.length > limit;
  const page = rows.slice(0, limit);

  const follows = new Set<string>();
  if (viewerId && page.length > 0) {
    const ids = page.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    const mutual = await env.DB.prepare(
      `SELECT following_id FROM follows WHERE follower_id = ? AND following_id IN (${placeholders})`,
    )
      .bind(viewerId, ...ids)
      .all<{ following_id: string }>();
    for (const row of mutual.results ?? []) follows.add(row.following_id);
  }

  return {
    entries: page.map((row) => ({
      id: row.id,
      handle: row.handle,
      displayName: row.display_name,
      bio: row.bio,
      avatarKey: row.avatar_key,
      role: row.role,
      viewerFollows: follows.has(row.id),
    })),
    hasNextPage,
  };
}

/**
 * Sanitizes and updates a user's display name, bio and avatar selection.
 *
 * @param values - The display name and bio to save. `avatarKey` is optional:
 * `undefined` leaves the stored avatar untouched (a form without the field
 * must not clobber it), `null` resets to the default initial-letter avatar,
 * and a string must be a known `preset:<id>` key — arbitrary strings never
 * reach the database.
 * @throws `ProfileValidationError` if the display name is shorter than the minimum length or longer than the maximum length, if the bio exceeds its allowed length, or if the avatar key is not a known preset.
 */
export async function updateUserProfile(
  env: AppEnv,
  userId: string,
  values: { displayName: string; bio: string; avatarKey?: string | null },
) {
  const displayName = sanitizeText(values.displayName);
  const bio = sanitizeText(values.bio, { multiline: true });
  const displayNameLength = countCodePoints(displayName, DISPLAY_NAME_MAX_LENGTH);
  if (displayNameLength < DISPLAY_NAME_MIN_LENGTH || displayNameLength > DISPLAY_NAME_MAX_LENGTH) {
    throw new ProfileValidationError("displayNameLength");
  }
  if (countCodePoints(bio, BIO_MAX_LENGTH) > BIO_MAX_LENGTH) {
    throw new ProfileValidationError("bioLength");
  }
  const avatarKey = values.avatarKey;
  if (typeof avatarKey === "string" && presetAvatarIdFromKey(avatarKey) === null) {
    throw new ProfileValidationError("avatarKey");
  }

  if (avatarKey === undefined) {
    await env.DB.prepare("UPDATE users SET display_name = ?, bio = ? WHERE id = ?")
      .bind(displayName, bio, userId)
      .run();
    return;
  }
  await env.DB.prepare("UPDATE users SET display_name = ?, bio = ?, avatar_key = ? WHERE id = ?")
    .bind(displayName, bio, avatarKey, userId)
    .run();
}
