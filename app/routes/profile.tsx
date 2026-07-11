import { CalendarDays, Heart, MessageCircle, Repeat2, UserRound } from "lucide-react";
import { data, Link, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/profile";
import { cloudflareContext } from "../cloudflare";
import { getSessionUser } from "../lib/auth.server";
import { getUserPosts, type TimelinePost } from "../lib/posts.server";
import { getUserProfileByHandle, updateUserProfile } from "../lib/users.server";

type ActionResult = { ok?: boolean; error?: string };

export function meta() {
  return [{ title: "プロフィール — Commons" }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const handle = String(params.handle ?? "")
    .trim()
    .replace(/^@/, "");
  const profile = await getUserProfileByHandle(env, handle);
  if (!profile) throw data(null, { status: 404 });

  const user = await getSessionUser(request, env);
  return {
    user,
    profile,
    posts: await getUserPosts(env, profile.id, user?.id ?? null),
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

  const displayName = String(formData.get("displayName") ?? "").trim();
  const bio = String(formData.get("bio") ?? "").trim();
  if (displayName.length < 1 || displayName.length > 30) {
    return data<ActionResult>({ error: "表示名は1〜30文字で入力してください。" }, { status: 400 });
  }
  if (bio.length > 160) {
    return data<ActionResult>({ error: "自己紹介は160文字以内で入力してください。" }, { status: 400 });
  }

  try {
    await updateUserProfile(env, user.id, { displayName, bio });
  } catch (error) {
    console.error("Failed to update profile", error);
    return data<ActionResult>({ error: "プロフィールを更新できませんでした。" }, { status: 500 });
  }

  return data<ActionResult>({ ok: true });
}

function normalizeDate(value: string) {
  return value.endsWith("Z") || value.includes("+") ? value : `${value.replace(" ", "T")}Z`;
}

function timeAgo(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(normalizeDate(value)).getTime()) / 1000));
  if (seconds < 60) return "今";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}時間`;
  return `${Math.floor(seconds / 86_400)}日`;
}

function joinedAt(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long" }).format(new Date(normalizeDate(value)));
}

function avatarClass(handle: string) {
  const classes = ["avatar-blue", "avatar-violet", "avatar-orange", "avatar-green"];
  return classes[handle.charCodeAt(0) % classes.length];
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
        <div className="post-identity">
          <strong>{post.name}</strong>
          {post.handle === "commons_dev" && (
            <span className="verified" aria-label="公式">
              ✓
            </span>
          )}
          <span>@{post.handle}</span>
          <span>·</span>
          <span>{timeAgo(post.createdAt)}</span>
        </div>
        <p style={{ margin: "8px 0 13px", lineHeight: 1.65, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {post.body}
        </p>
        <div style={{ display: "flex", gap: 24, color: "#69717d", fontSize: 12 }} aria-label="投稿の反応数">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <MessageCircle size={16} /> {post.replies}
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Repeat2 size={16} /> {post.reposts}
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Heart size={16} /> {post.likes}
          </span>
        </div>
      </div>
    </article>
  );
}

export default function ProfilePage({ loaderData }: Route.ComponentProps) {
  const { user, profile, posts } = loaderData;
  const fetcher = useFetcher<ActionResult>();
  const isOwner = user?.id === profile.id;
  const isSaving = fetcher.state !== "idle";

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
            {!isOwner && (
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

          {isOwner && (
            <fetcher.Form
              method="post"
              style={{
                marginTop: 22,
                padding: 16,
                border: "1px solid #e3e6eb",
                borderRadius: 14,
                background: "#fafbfc",
              }}
            >
              <input type="hidden" name="intent" value="updateProfile" />
              <h3 style={{ margin: "0 0 14px", fontSize: 16 }}>プロフィールを編集</h3>
              <label style={{ display: "grid", gap: 6, marginBottom: 12, fontSize: 13, fontWeight: 700 }}>
                表示名
                <input name="displayName" defaultValue={profile.displayName} required maxLength={30} />
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
                自己紹介
                <textarea name="bio" defaultValue={profile.bio} maxLength={160} rows={4} />
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="auth-submit"
                  style={{ width: "auto", paddingInline: 18 }}
                >
                  {isSaving ? "保存中…" : "保存する"}
                </button>
                {fetcher.data?.ok && <span style={{ color: "#238636", fontSize: 13 }}>更新しました。</span>}
              </div>
              {fetcher.data?.error && (
                <div role="alert" className="inline-error" style={{ marginTop: 10 }}>
                  {fetcher.data.error}
                </div>
              )}
            </fetcher.Form>
          )}
        </section>

        <div style={{ padding: "14px 18px", borderBottom: "1px solid #e7e9ed", fontWeight: 800 }}>投稿</div>
        {posts.length > 0 ? (
          posts.map((post) => <ProfilePost key={post.id} post={post} />)
        ) : (
          <div className="empty-state" style={{ minHeight: 260 }}>
            <UserRound size={30} />
            <strong>公開投稿はまだありません</strong>
          </div>
        )}
      </section>
    </main>
  );
}
