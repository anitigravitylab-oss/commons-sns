import { CalendarDays, Check, Settings, Shuffle, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { data, Link, redirect, useFetcher, useLocation } from "react-router";
import type { Route } from "./+types/profile";
import { cloudflareContext } from "../cloudflare";
import { getSessionUser } from "../lib/auth.server";
import { presetAvatarKey } from "../lib/avatar-constraints";
import { PRESET_AVATARS, PresetAvatarSymbol } from "../lib/avatar-presets";
import { avatarClass, normalizeDate, PostSummaryCard, UserAvatar } from "../lib/post-presentation";
import { getUserPosts, type TimelinePost } from "../lib/posts.server";
import { BIO_MAX_LENGTH, DISPLAY_NAME_MAX_LENGTH, DISPLAY_NAME_MIN_LENGTH } from "../lib/profile-constraints";
import { SubpageShell } from "../lib/subpage";
import { countCodePoints, sanitizeText, sliceCodePoints } from "../lib/text";
import {
  getUserProfileByHandle,
  isFollowing,
  ProfileValidationError,
  toggleFollow,
  updateUserProfile,
  type UserProfile,
} from "../lib/users.server";

type ActionResult = { ok?: boolean; error?: string };

export function meta() {
  return [{ title: "プロフィール — Commons" }];
}

const PROFILE_PAGE_SIZE = 20;

function handleFromParams(params: Route.LoaderArgs["params"]) {
  return String(params.handle ?? "")
    .trim()
    .replace(/^@/, "");
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const [profile, user] = await Promise.all([
    getUserProfileByHandle(env, handleFromParams(params)),
    getSessionUser(request, env),
  ]);
  if (!profile) throw data(null, { status: 404 });

  const requestedPage = Number.parseInt(new URL(request.url).searchParams.get("page") ?? "1", 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  let posts: TimelinePost[] = [];
  let hasNextPage = false;
  let postsError = false;
  let viewerFollows = false;
  try {
    const [fetchedPosts, following] = await Promise.all([
      getUserPosts(env, profile.id, user?.id ?? null, {
        limit: PROFILE_PAGE_SIZE + 1,
        offset: (page - 1) * PROFILE_PAGE_SIZE,
      }),
      user && user.id !== profile.id ? isFollowing(env, user.id, profile.id) : false,
    ]);
    posts = fetchedPosts.slice(0, PROFILE_PAGE_SIZE);
    hasNextPage = fetchedPosts.length > PROFILE_PAGE_SIZE;
    viewerFollows = following;
  } catch (error) {
    console.error("Failed to load profile posts", error);
    postsError = true;
  }

  return {
    user,
    profile,
    posts,
    page,
    hasNextPage,
    postsError,
    viewerFollows,
  };
}

/**
 * Processes authenticated profile actions (edit, follow) for the profile
 * identified by the route handle.
 *
 * @returns A redirect for unauthenticated requests, an error response for invalid or unauthorized requests, or `{ ok: true }` on success.
 * @throws A 404 response when the profile handle does not identify an existing profile.
 */
export async function action({ request, context, params }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await getSessionUser(request, env);
  if (!user) return redirect("/?auth=login");

  const profile = await getUserProfileByHandle(env, handleFromParams(params));
  if (!profile) throw data(null, { status: 404 });

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    console.error("profile action formData failed", error);
    return data<ActionResult>({ error: "問題が発生しました。時間をおいてもう一度お試しください。" }, { status: 500 });
  }
  const intent = String(formData.get("intent") ?? "");

  if (intent === "toggleFollow") {
    if (profile.id === user.id) {
      return data<ActionResult>({ error: "自分をフォローすることはできません。" }, { status: 400 });
    }
    try {
      await toggleFollow(env, user.id, profile.id);
    } catch (error) {
      console.error("Failed to toggle follow", error);
      return data<ActionResult>({ error: "フォロー状態を変更できませんでした。" }, { status: 500 });
    }
    return data<ActionResult>({ ok: true });
  }

  if (intent === "updateProfile") {
    if (profile.id !== user.id) {
      return data<ActionResult>({ error: "このプロフィールは編集できません。" }, { status: 403 });
    }

    const displayName = String(formData.get("displayName") ?? "");
    const bio = String(formData.get("bio") ?? "");
    // フィールドが無い（古いフォームの）送信はアイコンを変更しない。空文字は標準アイコンへ戻す。
    const avatarField = formData.get("avatarKey");
    const avatarKey = avatarField === null ? undefined : avatarField === "" ? null : String(avatarField);

    try {
      await updateUserProfile(env, user.id, { displayName, bio, avatarKey });
    } catch (error) {
      if (error instanceof ProfileValidationError) {
        const message =
          error.code === "displayNameLength"
            ? `表示名は${DISPLAY_NAME_MIN_LENGTH}〜${DISPLAY_NAME_MAX_LENGTH}文字で入力してください。`
            : error.code === "avatarKey"
              ? "アイコンの選択が正しくありません。選び直してください。"
              : `自己紹介は${BIO_MAX_LENGTH}文字以内で入力してください。`;
        return data<ActionResult>({ error: message }, { status: 400 });
      }
      console.error("Failed to update profile", error);
      return data<ActionResult>({ error: "プロフィールを更新できませんでした。" }, { status: 500 });
    }

    return data<ActionResult>({ ok: true });
  }

  return data<ActionResult>({ error: "不正な操作です。" }, { status: 400 });
}

function joinedAt(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long" }).format(new Date(normalizeDate(value)));
}

function FollowButton({ following }: { following: boolean }) {
  const fetcher = useFetcher<ActionResult>();
  // Optimistic: show the toggled state while the submission is in flight.
  const pending = fetcher.state !== "idle";
  const shownFollowing = pending ? !following : following;

  return (
    <div className="follow-control">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="toggleFollow" />
        <button
          type="submit"
          disabled={pending}
          className={shownFollowing ? "follow-button following" : "follow-button"}
        >
          {shownFollowing ? "フォロー中" : "フォローする"}
        </button>
      </fetcher.Form>
      {fetcher.data?.error && (
        <div role="alert" className="inline-error">
          {fetcher.data.error}
        </div>
      )}
    </div>
  );
}

/**
 * プリセットアバターの選択グリッド。値は `avatarKey` の radio 群として
 * フォームに乗る（空文字 = 標準の文字アイコン）。
 */
function AvatarPickerField({
  profile,
  displayName,
  avatarKey,
  onChange,
}: {
  profile: UserProfile;
  displayName: string;
  avatarKey: string;
  onChange: (value: string) => void;
}) {
  const shuffle = () => {
    const candidates = PRESET_AVATARS.filter((preset) => presetAvatarKey(preset.id) !== avatarKey);
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    if (pick) onChange(presetAvatarKey(pick.id));
  };

  return (
    <div className="pe-field">
      <div className="pe-field-head">
        <span id="pe-avatar-label" className="pe-field-label">
          アイコン
        </span>
        <button type="button" className="pe-avatar-shuffle" onClick={shuffle}>
          <Shuffle size={13} aria-hidden={true} /> おまかせ
        </button>
      </div>
      <div
        className="pe-avatar-grid"
        role="radiogroup"
        aria-labelledby="pe-avatar-label"
        aria-describedby="pe-avatar-caption"
      >
        <label className="pe-avatar-option" title="文字（標準）">
          <input type="radio" name="avatarKey" value="" checked={avatarKey === ""} onChange={() => onChange("")} />
          <span className={`avatar ${avatarClass(profile.handle)}`} aria-hidden="true">
            {sliceCodePoints(displayName.trim() || profile.handle, 1)}
          </span>
          <span className="sr-only">文字（標準）</span>
        </label>
        {PRESET_AVATARS.map((preset) => (
          <label key={preset.id} className="pe-avatar-option" title={preset.label}>
            <input
              type="radio"
              name="avatarKey"
              value={presetAvatarKey(preset.id)}
              checked={avatarKey === presetAvatarKey(preset.id)}
              onChange={() => onChange(presetAvatarKey(preset.id))}
            />
            <span
              className="avatar avatar-preset"
              style={{ background: preset.background, color: preset.foreground }}
              aria-hidden="true"
            >
              <PresetAvatarSymbol preset={preset} />
            </span>
            <span className="sr-only">{preset.label}</span>
          </label>
        ))}
      </div>
      <p id="pe-avatar-caption" className="pe-caption">
        画像を用意しなくても、シンボルをプロフィールアイコンに設定できます。
      </p>
    </div>
  );
}

function ProfileEditModal({
  profile,
  onClose,
  onSaved,
}: {
  profile: UserProfile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const fetcher = useFetcher<ActionResult>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [bio, setBio] = useState(profile.bio);
  const [avatarKey, setAvatarKey] = useState(profile.avatarKey ?? "");

  // Open as a modal and restore focus to the trigger on close (mirrors AuthModal).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (!dialog.open) dialog.showModal();

    return () => {
      if (dialog.open) dialog.close();
      previouslyFocused?.focus();
    };
  }, []);

  // アバターの radio 群より、まず本文の編集対象である表示名へフォーカスする。
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>("#pe-display-name")?.focus();
  }, []);

  const saved = fetcher.state === "idle" && fetcher.data?.ok === true;
  useEffect(() => {
    if (saved) onSaved();
  }, [saved, onSaved]);

  const sanitizedName = sanitizeText(displayName);
  const sanitizedBio = sanitizeText(bio, { multiline: true });
  const nameCount = countCodePoints(sanitizedName);
  const bioCount = countCodePoints(sanitizedBio);
  const nameEmpty = nameCount < DISPLAY_NAME_MIN_LENGTH;
  const nameOver = nameCount > DISPLAY_NAME_MAX_LENGTH;
  const bioOver = bioCount > BIO_MAX_LENGTH;
  const isSaving = fetcher.state !== "idle";
  const canSave = !isSaving && !nameEmpty && !nameOver && !bioOver;

  return (
    <div className="modal-backdrop" role="presentation">
      <dialog
        ref={dialogRef}
        className="profile-edit-modal"
        aria-labelledby="profile-edit-title"
        onPointerDown={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const clickedOutside =
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom;
          if (clickedOutside) onClose();
        }}
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <div className="pe-banner">
          <button type="button" className="modal-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
          <UserAvatar
            name={displayName.trim() || profile.handle}
            handle={profile.handle}
            avatarKey={avatarKey || null}
            className="pe-avatar"
          />
        </div>

        <div className="pe-body">
          <h2 id="profile-edit-title">プロフィールを編集</h2>
          <fetcher.Form
            method="post"
            className="pe-form"
            onSubmit={(event) => {
              if (!canSave) event.preventDefault();
            }}
          >
            <input type="hidden" name="intent" value="updateProfile" />

            <AvatarPickerField
              profile={profile}
              displayName={displayName}
              avatarKey={avatarKey}
              onChange={setAvatarKey}
            />

            <div className="pe-field">
              <div className="pe-field-head">
                <label htmlFor="pe-display-name">表示名</label>
                <span className={`pe-counter ${nameOver ? "over" : ""}`}>
                  {nameCount}/{DISPLAY_NAME_MAX_LENGTH}
                </span>
              </div>
              <input
                id="pe-display-name"
                name="displayName"
                className="pe-input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
                autoComplete="name"
                aria-invalid={nameEmpty || nameOver}
                aria-describedby="pe-display-name-caption"
              />
              <p id="pe-display-name-caption" className="pe-caption">
                タイムラインやプロフィールに表示される名前です。
              </p>
            </div>

            <div className="pe-field">
              <div className="pe-field-head">
                <label htmlFor="pe-bio">自己紹介</label>
                <span className={`pe-counter ${bioOver ? "over" : ""}`}>
                  {bioCount}/{BIO_MAX_LENGTH}
                </span>
              </div>
              <textarea
                id="pe-bio"
                name="bio"
                className="pe-textarea"
                value={bio}
                onChange={(event) => setBio(event.target.value)}
                rows={4}
                aria-invalid={bioOver}
                aria-describedby="pe-bio-caption"
              />
              <p id="pe-bio-caption" className="pe-caption">
                興味や活動を書いてみましょう。ハッシュタグ（#）も使えます。
              </p>
            </div>

            {fetcher.data?.error && (
              <div role="alert" className="form-error">
                {fetcher.data.error}
              </div>
            )}

            <div className="pe-actions">
              <button type="button" className="pe-cancel" onClick={onClose}>
                キャンセル
              </button>
              <button type="submit" className="pe-save" disabled={!canSave}>
                {isSaving ? "保存中…" : "保存する"}
              </button>
            </div>
          </fetcher.Form>
        </div>
      </dialog>
    </div>
  );
}

export default function ProfilePage({ loaderData }: Route.ComponentProps) {
  const { user, profile, posts, page, hasNextPage, postsError, viewerFollows } = loaderData;
  const isOwner = user?.id === profile.id;
  // ページ内リンクで router state (backTo) を引き継ぎ、戻り先のタブを保持する。
  const location = useLocation();
  const [editing, setEditing] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    if (!savedNotice) return;
    const timer = setTimeout(() => setSavedNotice(false), 2600);
    return () => clearTimeout(timer);
  }, [savedNotice]);

  const handleSaved = useCallback(() => {
    setEditing(false);
    setSavedNotice(true);
  }, []);

  return (
    <>
      <SubpageShell
        heading={
          <>
            <h1>{profile.displayName}</h1>
            <p className="subpage-subtitle">{profile.postCount}件の投稿</p>
          </>
        }
      >
        <div className="profile-banner" />
        <section className="profile-summary">
          <div className="profile-summary-top">
            <UserAvatar
              name={profile.displayName}
              handle={profile.handle}
              avatarKey={profile.avatarKey}
              className="profile-avatar"
            />
            {isOwner ? (
              <div className="profile-actions">
                <Link to="/settings" state={location.state} className="profile-edit-button" aria-label="アカウント設定">
                  <Settings size={16} aria-hidden={true} /> 設定
                </Link>
                <button type="button" className="profile-edit-button" onClick={() => setEditing(true)}>
                  プロフィールを編集
                </button>
              </div>
            ) : user ? (
              <FollowButton key={String(viewerFollows)} following={viewerFollows} />
            ) : (
              <Link to="/?auth=login" className="follow-button">
                フォローする
              </Link>
            )}
          </div>

          <h2 className="profile-name">{profile.displayName}</h2>
          <p className="profile-handle">@{profile.handle}</p>
          <p className="profile-bio">{profile.bio || "自己紹介はまだありません。"}</p>
          <div className="profile-meta">
            <CalendarDays size={16} aria-hidden={true} /> {joinedAt(profile.createdAt)}からCommonsを利用
          </div>
          <div className="profile-follow-stats">
            <span>
              <strong>{profile.followingCount}</strong> <span>フォロー中</span>
            </span>
            <span>
              <strong>{profile.followerCount}</strong> <span>フォロワー</span>
            </span>
          </div>
        </section>

        <div className="section-heading">投稿</div>
        {postsError ? (
          <div className="form-error subpage-alert" role="alert">
            投稿を読み込めませんでした。時間をおいて再読み込みしてください。
          </div>
        ) : posts.length > 0 ? (
          <>
            {posts.map((post) => (
              <PostSummaryCard key={post.id} post={post} />
            ))}
            <nav aria-label="プロフィール投稿のページ移動" className="pager">
              {page > 1 ? (
                <Link to={`?page=${page - 1}`} state={location.state}>
                  ← 新しい投稿
                </Link>
              ) : (
                <span />
              )}
              {hasNextPage && (
                <Link to={`?page=${page + 1}`} state={location.state}>
                  過去の投稿 →
                </Link>
              )}
            </nav>
          </>
        ) : (
          <div className="empty-state tall">
            <UserRound size={30} />
            <strong>{page > 1 ? "このページには投稿がありません" : "公開投稿はまだありません"}</strong>
            {page > 1 && (
              <Link to="?page=1" state={location.state}>
                最初のページへ戻る
              </Link>
            )}
          </div>
        )}
      </SubpageShell>

      {isOwner && editing && (
        <ProfileEditModal profile={profile} onClose={() => setEditing(false)} onSaved={handleSaved} />
      )}

      {savedNotice && (
        <output className="profile-saved-toast">
          <Check size={16} aria-hidden="true" /> プロフィールを更新しました
        </output>
      )}
    </>
  );
}
