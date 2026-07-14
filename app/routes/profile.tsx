import { CalendarDays, Check, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { data, Link, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/profile";
import { cloudflareContext } from "../cloudflare";
import { getSessionUser } from "../lib/auth.server";
import { avatarClass, normalizeDate, PostIdentity, PostReactionCounts } from "../lib/post-presentation";
import { getUserPosts, type TimelinePost } from "../lib/posts.server";
import { BIO_MAX_LENGTH, DISPLAY_NAME_MAX_LENGTH, DISPLAY_NAME_MIN_LENGTH } from "../lib/profile-constraints";
import { countCodePoints } from "../lib/text";
import {
  getUserProfileByHandle,
  ProfileValidationError,
  updateUserProfile,
  type UserProfile,
} from "../lib/users.server";

type ActionResult = { ok?: boolean; error?: string };

export function meta() {
  return [{ title: "プロフィール — Commons" }];
}

const PROFILE_PAGE_SIZE = 20;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const handle = String(params.handle ?? "")
    .trim()
    .replace(/^@/, "");
  const profile = await getUserProfileByHandle(env, handle);
  if (!profile) throw data(null, { status: 404 });

  const user = await getSessionUser(request, env);
  const requestedPage = Number.parseInt(new URL(request.url).searchParams.get("page") ?? "1", 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  let posts: TimelinePost[] = [];
  let hasNextPage = false;
  let postsError = false;
  try {
    const fetchedPosts = await getUserPosts(env, profile.id, user?.id ?? null, {
      limit: PROFILE_PAGE_SIZE + 1,
      offset: (page - 1) * PROFILE_PAGE_SIZE,
    });
    posts = fetchedPosts.slice(0, PROFILE_PAGE_SIZE);
    hasNextPage = fetchedPosts.length > PROFILE_PAGE_SIZE;
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
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await getSessionUser(request, env);
  if (!user) return redirect("/");

  const handle = String(params.handle ?? "")
    .trim()
    .replace(/^@/, "");
  const profile = await getUserProfileByHandle(env, handle);
  if (!profile) throw data(null, { status: 404 });
  if (profile.id !== user.id) {
    return data<ActionResult>({ error: "このプロフィールは編集できません。" }, { status: 403 });
  }

  const formData = await request.formData();
  if (String(formData.get("intent") ?? "") !== "updateProfile") {
    return data<ActionResult>({ error: "不正な操作です。" }, { status: 400 });
  }

  const displayName = String(formData.get("displayName") ?? "");
  const bio = String(formData.get("bio") ?? "");

  try {
    await updateUserProfile(env, user.id, { displayName, bio });
  } catch (error) {
    if (error instanceof ProfileValidationError) {
      const message =
        error.code === "displayNameLength"
          ? `表示名は${DISPLAY_NAME_MIN_LENGTH}〜${DISPLAY_NAME_MAX_LENGTH}文字で入力してください。`
          : `自己紹介は${BIO_MAX_LENGTH}文字以内で入力してください。`;
      return data<ActionResult>({ error: message }, { status: 400 });
    }
    console.error("Failed to update profile", error);
    return data<ActionResult>({ error: "プロフィールを更新できませんでした。" }, { status: 500 });
  }

  return data<ActionResult>({ ok: true });
}

function joinedAt(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long" }).format(new Date(normalizeDate(value)));
}

function ProfilePost({ post }: { post: TimelinePost }) {
  return (
    <article
      style={{
        display: "grid",
        gridTemplateColumns: "42px minmax(0, 1fr)",
        gap: 12,
        padding: "18px",
        borderBottom: "1px solid #e7e9ed",
      }}
    >
      <div className={`avatar ${avatarClass(post.handle)}`}>{post.name.slice(0, 1)}</div>
      <div style={{ minWidth: 0 }}>
        <PostIdentity name={post.name} handle={post.handle} createdAt={post.createdAt} />
        <p style={{ margin: "8px 0 13px", lineHeight: 1.65, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {post.body}
        </p>
        <PostReactionCounts replies={post.replies} reposts={post.reposts} likes={post.likes} />
      </div>
    </article>
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

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>("input:not([type='hidden'])")?.focus();
  }, []);

  const saved = fetcher.state === "idle" && fetcher.data?.ok === true;
  useEffect(() => {
    if (saved) onSaved();
  }, [saved, onSaved]);

  const nameCount = countCodePoints(displayName);
  const bioCount = countCodePoints(bio);
  const nameEmpty = countCodePoints(displayName.trim()) < DISPLAY_NAME_MIN_LENGTH;
  const nameOver = nameCount > DISPLAY_NAME_MAX_LENGTH;
  const bioOver = bioCount > BIO_MAX_LENGTH;
  const isSaving = fetcher.state !== "idle";
  const canSave = !isSaving && !nameEmpty && !nameOver && !bioOver;
  const previewInitial = (displayName.trim() || profile.handle).slice(0, 1);

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
          <div className={`avatar ${avatarClass(profile.handle)} pe-avatar`} aria-hidden="true">
            {previewInitial}
          </div>
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
  const { user, profile, posts, page, hasNextPage, postsError } = loaderData;
  const isOwner = user?.id === profile.id;
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
    <main style={{ minHeight: "100vh", background: "#f7f8fa" }}>
      <section
        style={{
          width: "min(100%, 680px)",
          minHeight: "100vh",
          margin: "0 auto",
          borderInline: "1px solid #e7e9ed",
          background: "white",
        }}
      >
        <header
          style={{
            position: "sticky",
            top: 0,
            zIndex: 20,
            padding: "14px 18px",
            borderBottom: "1px solid #e7e9ed",
            background: "rgba(255,255,255,0.94)",
            backdropFilter: "blur(16px)",
          }}
        >
          <Link to="/" style={{ color: "#2867e8", fontSize: 13, fontWeight: 700 }}>
            ← タイムラインへ戻る
          </Link>
          <h1 style={{ margin: "10px 0 0", fontSize: 20 }}>{profile.displayName}</h1>
          <span style={{ color: "#69717d", fontSize: 12 }}>{profile.postCount}件の投稿</span>
        </header>

        <div style={{ height: 150, background: "linear-gradient(135deg, #dce9ff, #f2e9ff)" }} />
        <section style={{ padding: "0 20px 22px", borderBottom: "1px solid #e7e9ed" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: -44 }}>
            <div
              className={`avatar ${avatarClass(profile.handle)}`}
              style={{ width: 88, height: 88, fontSize: 32, border: "4px solid white" }}
            >
              {profile.displayName.slice(0, 1)}
            </div>
            {isOwner ? (
              <button type="button" className="profile-edit-button" onClick={() => setEditing(true)}>
                プロフィールを編集
              </button>
            ) : (
              <button
                type="button"
                disabled
                title="フォロー機能は次の実装予定です"
                style={{
                  border: "1px solid #d8dce3",
                  borderRadius: 999,
                  padding: "9px 16px",
                  background: "white",
                  fontWeight: 700,
                  color: "#8b929d",
                }}
              >
                フォロー準備中
              </button>
            )}
          </div>

          <h2 style={{ margin: "14px 0 2px", fontSize: 24 }}>{profile.displayName}</h2>
          <p style={{ margin: 0, color: "#69717d" }}>@{profile.handle}</p>
          <p style={{ margin: "16px 0", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
            {profile.bio || "自己紹介はまだありません。"}
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 7, color: "#69717d", fontSize: 13 }}>
            <CalendarDays size={16} /> {joinedAt(profile.createdAt)}からCommonsを利用
          </div>
          <div style={{ display: "flex", gap: 18, marginTop: 14, fontSize: 14 }}>
            <span>
              <strong>{profile.followingCount}</strong> <span style={{ color: "#69717d" }}>フォロー中</span>
            </span>
            <span>
              <strong>{profile.followerCount}</strong> <span style={{ color: "#69717d" }}>フォロワー</span>
            </span>
          </div>
        </section>

        <div style={{ padding: "14px 18px", borderBottom: "1px solid #e7e9ed", fontWeight: 800 }}>投稿</div>
        {postsError ? (
          <div className="form-error" role="alert" style={{ margin: 18 }}>
            投稿を読み込めませんでした。時間をおいて再読み込みしてください。
          </div>
        ) : posts.length > 0 ? (
          <>
            {posts.map((post) => (
              <ProfilePost key={post.id} post={post} />
            ))}
            <nav
              aria-label="プロフィール投稿のページ移動"
              style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "18px" }}
            >
              {page > 1 ? (
                <Link to={`?page=${page - 1}`} style={{ color: "#2867e8", fontWeight: 700 }}>
                  ← 新しい投稿
                </Link>
              ) : (
                <span />
              )}
              {hasNextPage && (
                <Link to={`?page=${page + 1}`} style={{ color: "#2867e8", fontWeight: 700 }}>
                  過去の投稿 →
                </Link>
              )}
            </nav>
          </>
        ) : (
          <div className="empty-state" style={{ minHeight: 260 }}>
            <UserRound size={30} />
            <strong>{page > 1 ? "このページには投稿がありません" : "公開投稿はまだありません"}</strong>
            {page > 1 && (
              <Link to="?page=1" style={{ color: "#2867e8", fontWeight: 700 }}>
                最初のページへ戻る
              </Link>
            )}
          </div>
        )}
      </section>

      {isOwner && editing && (
        <ProfileEditModal profile={profile} onClose={() => setEditing(false)} onSaved={handleSaved} />
      )}

      {savedNotice && (
        <output className="profile-saved-toast">
          <Check size={16} aria-hidden="true" /> プロフィールを更新しました
        </output>
      )}
    </main>
  );
}
