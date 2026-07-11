import {
  Bell,
  Bookmark,
  CircleEllipsis,
  Code2,
  Feather,
  Heart,
  Home,
  Image as ImageIcon,
  LogIn,
  LogOut,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Repeat2,
  Search,
  Settings,
  Sparkles,
  Trash2,
  UserRound,
  UsersRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { data, Form, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/home";
import { cloudflareContext } from "../cloudflare";
import {
  createSession,
  destroySession,
  findUserForLogin,
  getSessionUser,
  hashPassword,
  verifyPassword,
} from "../lib/auth.server";
import type { SessionUser } from "../lib/auth.server";
import { getTimeline } from "../lib/posts.server";
import type { TimelinePost } from "../lib/posts.server";

type ActionResult = {
  ok?: boolean;
  error?: string;
  form?: "login" | "signup";
};

export function meta() {
  return [
    { title: "Commons — みんなで育てるSNS" },
    { name: "description", content: "中央集権型の、コミュニティ開発OSS SNS" },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await getSessionUser(request, env);
  return { user, posts: await getTimeline(env, user?.id ?? null) };
}

function formText(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const formData = await request.formData();
  const intent = formText(formData, "intent");

  if (intent === "signup") {
    const handle = formText(formData, "handle").toLowerCase().replace(/^@/, "");
    const displayName = formText(formData, "displayName");
    const password = String(formData.get("password") ?? "");
    if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
      return data<ActionResult>(
        { error: "IDは3〜20文字の半角英数字と_で入力してください。", form: "signup" },
        { status: 400 },
      );
    }
    if (displayName.length < 1 || displayName.length > 30) {
      return data<ActionResult>({ error: "表示名は1〜30文字で入力してください。", form: "signup" }, { status: 400 });
    }
    if (password.length < 8 || password.length > 128) {
      return data<ActionResult>(
        { error: "パスワードは8〜128文字で入力してください。", form: "signup" },
        { status: 400 },
      );
    }
    const userId = crypto.randomUUID();
    const { hash, salt } = await hashPassword(password);
    try {
      await env.DB.prepare(
        `INSERT INTO users (id, handle, display_name, password_hash, password_salt)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(userId, handle, displayName, hash, salt)
        .run();
    } catch {
      return data<ActionResult>({ error: "そのIDはすでに使われています。", form: "signup" }, { status: 409 });
    }
    return redirect("/", { headers: { "Set-Cookie": await createSession(env, userId) } });
  }

  if (intent === "login") {
    const handle = formText(formData, "handle").toLowerCase().replace(/^@/, "");
    const password = String(formData.get("password") ?? "");
    const user = await findUserForLogin(env, handle);
    if (
      !user?.password_hash ||
      !user.password_salt ||
      !(await verifyPassword(password, user.password_hash, user.password_salt))
    ) {
      return data<ActionResult>({ error: "IDまたはパスワードが違います。", form: "login" }, { status: 401 });
    }
    return redirect("/", { headers: { "Set-Cookie": await createSession(env, user.id) } });
  }

  if (intent === "logout") {
    return redirect("/", { headers: { "Set-Cookie": await destroySession(request, env) } });
  }

  const user = await getSessionUser(request, env);
  if (!user) return data<ActionResult>({ error: "この操作にはログインが必要です。", form: "login" }, { status: 401 });

  if (intent === "createPost") {
    const body = formText(formData, "body");
    if (!body || body.length > 280)
      return data<ActionResult>({ error: "投稿は1〜280文字で入力してください。" }, { status: 400 });
    await env.DB.prepare("INSERT INTO posts (id, author_id, body, visibility) VALUES (?, ?, ?, 'public')")
      .bind(crypto.randomUUID(), user.id, body)
      .run();
    return data<ActionResult>({ ok: true });
  }

  if (intent === "toggleReaction") {
    const postId = formText(formData, "postId");
    const kind = formText(formData, "kind");
    if (!postId || !["like", "repost", "bookmark"].includes(kind)) {
      return data<ActionResult>({ error: "不正な操作です。" }, { status: 400 });
    }
    const exists = await env.DB.prepare(
      "SELECT 1 AS present FROM post_reactions WHERE user_id = ? AND post_id = ? AND kind = ?",
    )
      .bind(user.id, postId, kind)
      .first<{ present: number }>();
    if (exists) {
      await env.DB.prepare("DELETE FROM post_reactions WHERE user_id = ? AND post_id = ? AND kind = ?")
        .bind(user.id, postId, kind)
        .run();
    } else {
      await env.DB.prepare("INSERT INTO post_reactions (user_id, post_id, kind) VALUES (?, ?, ?)")
        .bind(user.id, postId, kind)
        .run();
    }
    return data<ActionResult>({ ok: true });
  }

  if (intent === "deletePost") {
    const postId = formText(formData, "postId");
    await env.DB.prepare(
      "UPDATE posts SET deleted_at = datetime('now') WHERE id = ? AND author_id = ? AND deleted_at IS NULL",
    )
      .bind(postId, user.id)
      .run();
    return data<ActionResult>({ ok: true });
  }

  return data<ActionResult>({ error: "不明な操作です。" }, { status: 400 });
}

const navItems = [
  { label: "ホーム", icon: Home },
  { label: "見つける", icon: Search },
  { label: "通知", icon: Bell },
  { label: "メッセージ", icon: Mail },
  { label: "ブックマーク", icon: Bookmark },
  { label: "コミュニティ", icon: UsersRound },
  { label: "プロフィール", icon: UserRound },
  { label: "設定", icon: Settings },
];

const mobileNavItems = [
  { id: "home", icon: Home },
  { id: "search", icon: Search },
  { id: "compose", icon: Feather },
  { id: "notifications", icon: Bell },
  { id: "profile", icon: UserRound },
];

function timeAgo(value: string) {
  const normalized = value.endsWith("Z") || value.includes("+") ? value : `${value.replace(" ", "T")}Z`;
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(normalized).getTime()) / 1000));
  if (seconds < 60) return "今";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}時間`;
  return `${Math.floor(seconds / 86_400)}日`;
}

function avatarClass(handle: string) {
  const classes = ["avatar-blue", "avatar-violet", "avatar-orange", "avatar-green"];
  return classes[handle.charCodeAt(0) % classes.length];
}

function UserAvatar({ user, small = false }: { user: Pick<SessionUser, "displayName" | "handle">; small?: boolean }) {
  return (
    <div className={`avatar ${avatarClass(user.handle)}${small ? " small" : ""}`}>{user.displayName.slice(0, 1)}</div>
  );
}

function AuthModal({
  mode,
  error,
  onClose,
  onChange,
}: {
  mode: "login" | "signup";
  error?: string;
  onClose: () => void;
  onChange: (mode: "login" | "signup") => void;
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <dialog open className="auth-modal" aria-labelledby="auth-title">
        <button className="modal-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
        <span className="brand-mark auth-brand">
          <span />
        </span>
        <h2 id="auth-title">{mode === "login" ? "Commonsにログイン" : "Commonsをはじめる"}</h2>
        <p>{mode === "login" ? "おかえりなさい。" : "メールアドレスなしですぐに登録できます。"}</p>
        <Form method="post" action="?index" className="auth-form">
          <input type="hidden" name="intent" value={mode} />
          {mode === "signup" && (
            <label>
              表示名
              <input name="displayName" required maxLength={30} autoComplete="name" placeholder="例：あおい" />
            </label>
          )}
          <label>
            ユーザーID
            <input
              name="handle"
              required
              minLength={3}
              maxLength={20}
              autoCapitalize="none"
              autoComplete="username"
              placeholder="例：aoi_note"
            />
          </label>
          <label>
            パスワード
            <input
              name="password"
              type="password"
              required
              minLength={8}
              maxLength={128}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="auth-submit" type="submit">
            {mode === "login" ? "ログイン" : "アカウントを作成"}
          </button>
        </Form>
        <button className="auth-switch" onClick={() => onChange(mode === "login" ? "signup" : "login")}>
          {mode === "login" ? "はじめての方はこちら" : "すでにアカウントをお持ちの方"}
        </button>
      </dialog>
    </div>
  );
}

function Composer({ user, onRequireLogin }: { user: SessionUser | null; onRequireLogin: () => void }) {
  const fetcher = useFetcher<ActionResult>();
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (fetcher.data?.ok && fetcher.state === "idle") setDraft("");
  }, [fetcher.data, fetcher.state]);

  if (!user) {
    return (
      <button className="login-prompt" onClick={onRequireLogin}>
        <LogIn size={18} />
        <span>ログインして、最初の投稿をしてみよう</span>
      </button>
    );
  }

  return (
    <fetcher.Form method="post" action="?index" className="composer">
      <input type="hidden" name="intent" value="createPost" />
      <UserAvatar user={user} />
      <div className="composer-main">
        <textarea
          id="composer"
          name="body"
          value={draft}
          onChange={(event) => setDraft(event.target.value.slice(0, 280))}
          placeholder="いまどうしてる？"
          rows={2}
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <button type="button" disabled title="画像投稿は次のアップデートで対応します">
              <ImageIcon size={19} />
            </button>
            <button type="button">全員に公開</button>
          </div>
          <div className="composer-submit">
            {draft.length > 0 && (
              <span className={draft.length > 260 ? "limit near" : "limit"}>{280 - draft.length}</span>
            )}
            <button type="submit" disabled={!draft.trim() || fetcher.state !== "idle"}>
              {fetcher.state === "idle" ? "投稿する" : "送信中"}
            </button>
          </div>
        </div>
        {fetcher.data?.error && <div className="inline-error">{fetcher.data.error}</div>}
      </div>
    </fetcher.Form>
  );
}

function ReactionButton({
  post,
  kind,
  user,
  onRequireLogin,
}: {
  post: TimelinePost;
  kind: "like" | "repost" | "bookmark";
  user: SessionUser | null;
  onRequireLogin: () => void;
}) {
  const fetcher = useFetcher<ActionResult>();
  const active = kind === "like" ? post.liked : kind === "repost" ? post.reposted : post.bookmarked;
  const count = kind === "like" ? post.likes : kind === "repost" ? post.reposts : undefined;
  const Icon = kind === "like" ? Heart : kind === "repost" ? Repeat2 : Bookmark;
  const label = kind === "like" ? "いいね" : kind === "repost" ? "リポスト" : "ブックマーク";
  if (!user)
    return (
      <button onClick={onRequireLogin} aria-label={label}>
        <span>
          <Icon size={18} />
        </span>
        {count !== undefined && <small>{count || ""}</small>}
      </button>
    );
  return (
    <fetcher.Form method="post" action="?index">
      <input type="hidden" name="intent" value="toggleReaction" />
      <input type="hidden" name="postId" value={post.id} />
      <input type="hidden" name="kind" value={kind} />
      <button
        type="submit"
        disabled={fetcher.state !== "idle"}
        className={active ? (kind === "like" ? "liked" : kind === "repost" ? "reposted" : "bookmarked") : ""}
        aria-label={label}
      >
        <span>
          <Icon size={18} fill={active && kind !== "repost" ? "currentColor" : "none"} />
        </span>
        {count !== undefined && <small>{count || ""}</small>}
      </button>
    </fetcher.Form>
  );
}

function PostCard({
  post,
  user,
  onRequireLogin,
}: {
  post: TimelinePost;
  user: SessionUser | null;
  onRequireLogin: () => void;
}) {
  const deleteFetcher = useFetcher<ActionResult>();
  return (
    <article className="post">
      <div className={`avatar ${avatarClass(post.handle)}`}>{post.name.slice(0, 1)}</div>
      <div className="post-content">
        <header>
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
          {user?.id === post.authorId ? (
            <deleteFetcher.Form method="post" action="?index">
              <input type="hidden" name="intent" value="deletePost" />
              <input type="hidden" name="postId" value={post.id} />
              <button type="submit" aria-label="削除">
                <Trash2 size={17} />
              </button>
            </deleteFetcher.Form>
          ) : (
            <button aria-label="その他">
              <MoreHorizontal size={19} />
            </button>
          )}
        </header>
        <p>{post.body}</p>
        <footer className="post-actions">
          <button onClick={user ? undefined : onRequireLogin} aria-label="返信">
            <span>
              <MessageCircle size={18} />
            </span>
            <small>{post.replies || ""}</small>
          </button>
          <ReactionButton post={post} kind="repost" user={user} onRequireLogin={onRequireLogin} />
          <ReactionButton post={post} kind="like" user={user} onRequireLogin={onRequireLogin} />
          <ReactionButton post={post} kind="bookmark" user={user} onRequireLogin={onRequireLogin} />
        </footer>
      </div>
    </article>
  );
}

export default function HomePage({ loaderData, actionData }: Route.ComponentProps) {
  const { user, posts } = loaderData;
  const [query, setQuery] = useState("");
  const [activeNav, setActiveNav] = useState("ホーム");
  const [activeTab, setActiveTab] = useState<"おすすめ" | "フォロー中">("おすすめ");
  const [authMode, setAuthMode] = useState<"login" | "signup" | null>(null);
  const [dismissedAction, setDismissedAction] = useState(false);
  const visibleAuthMode = authMode ?? (!dismissedAction ? actionData?.form : null) ?? null;
  const visiblePosts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return posts;
    return posts.filter((post) => `${post.name} ${post.handle} ${post.body}`.toLowerCase().includes(normalized));
  }, [posts, query]);

  const openAuth = (mode: "login" | "signup") => {
    setDismissedAction(false);
    setAuthMode(mode);
  };
  const requireLogin = () => openAuth("login");
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-inner">
          <button className="brand" aria-label="Commons ホーム" onClick={() => setActiveNav("ホーム")}>
            <span className="brand-mark">
              <span />
            </span>
            <span className="brand-name">Commons</span>
            <span className="brand-beta">BETA</span>
          </button>
          <nav className="main-nav" aria-label="メインナビゲーション">
            {navItems.map(({ label, icon: Icon }) => (
              <button
                key={label}
                className={activeNav === label ? "nav-item active" : "nav-item"}
                onClick={() => setActiveNav(label)}
              >
                <span className="nav-icon-wrap">
                  <Icon size={23} strokeWidth={activeNav === label ? 2.5 : 1.9} />
                </span>
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <button
            className="post-button"
            onClick={() => (user ? document.querySelector<HTMLTextAreaElement>("#composer")?.focus() : requireLogin())}
          >
            <Feather size={19} />
            <span>投稿する</span>
          </button>
          {user ? (
            <div className="account-switcher">
              <UserAvatar user={user} small />
              <span className="account-copy">
                <strong>{user.displayName}</strong>
                <small>@{user.handle}</small>
              </span>
              <Form method="post" action="?index">
                <input type="hidden" name="intent" value="logout" />
                <button className="icon-button" type="submit" aria-label="ログアウト">
                  <LogOut size={17} />
                </button>
              </Form>
            </div>
          ) : (
            <button className="account-switcher logged-out" onClick={requireLogin}>
              <LogIn size={20} />
              <span className="account-copy">
                <strong>ログイン</strong>
                <small>または新規登録</small>
              </span>
            </button>
          )}
        </div>
      </aside>

      <section className="feed-column">
        <header className="feed-header">
          <div className="mobile-brand">
            <span className="brand-mark">
              <span />
            </span>
          </div>
          <div className="tabs" role="tablist">
            {(["おすすめ", "フォロー中"] as const).map((tab) => (
              <button
                key={tab}
                role="tab"
                aria-selected={activeTab === tab}
                className={activeTab === tab ? "tab active" : "tab"}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>
          <button
            className={`mobile-avatar avatar ${user ? avatarClass(user.handle) : "avatar-dark"}`}
            onClick={() => (user ? undefined : requireLogin())}
          >
            {user?.displayName.slice(0, 1) ?? "?"}
          </button>
        </header>
        <div className="topic-strip">
          <Sparkles size={15} />
          <span>いま話されていること</span>
          <strong>みんなで決める最初の機能</strong>
          <button>参加する</button>
        </div>
        <Composer user={user} onRequireLogin={requireLogin} />
        <div className="feed-status">
          <span>{activeTab}の投稿</span>
          <button>新しい順</button>
        </div>
        <div className="posts" aria-live="polite">
          {visiblePosts.length === 0 ? (
            <div className="empty-state">
              <Search size={28} />
              <strong>投稿が見つかりません</strong>
              <span>{query ? "別の言葉で検索してみてください。" : "最初の投稿をしてみましょう。"}</span>
            </div>
          ) : (
            visiblePosts.map((post) => <PostCard key={post.id} post={post} user={user} onRequireLogin={requireLogin} />)
          )}
        </div>
      </section>

      <aside className="rightbar">
        <div className="rightbar-inner">
          <label className="search-box">
            <Search size={18} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Commonsを検索" />
            {query && (
              <button onClick={() => setQuery("")} aria-label="検索を消す">
                ×
              </button>
            )}
          </label>
          {!user && (
            <section className="side-card join-card">
              <h2>Commonsをはじめよう</h2>
              <p>登録は無料。メールアドレスは必要ありません。</p>
              <button onClick={() => openAuth("signup")}>アカウントを作成</button>
              <button className="secondary" onClick={() => openAuth("login")}>
                ログイン
              </button>
            </section>
          )}
          <section className="side-card project-card">
            <div className="eyebrow">
              <Code2 size={15} /> OPEN SOURCE
            </div>
            <h2>このSNSを、一緒につくる。</h2>
            <p>機能提案、デザイン、翻訳、コード。得意な方法で開発に参加できます。</p>
            <a
              className="project-link"
              href="https://github.com/anitigravitylab-oss/commons-sns"
              target="_blank"
              rel="noreferrer"
            >
              開発に参加する <span>→</span>
            </a>
          </section>
          <section className="side-card trends-card">
            <div className="card-title">
              <h2>いまの話題</h2>
              <button>
                <CircleEllipsis size={19} />
              </button>
            </div>
            {[
              ["コミュニティ", "最初にほしい機能"],
              ["開発", "#CommonsDev"],
              ["日本のトレンド", "小さなSNS"],
            ].map(([kind, title]) => (
              <button className="trend" key={title}>
                <small>{kind}</small>
                <strong>{title}</strong>
              </button>
            ))}
          </section>
          <footer className="legal-links">
            <a href="https://github.com/anitigravitylab-oss/commons-sns">ソースコード</a>
            <a href="https://github.com/anitigravitylab-oss/commons-sns/blob/main/LICENSE">AGPL-3.0</a>
            <span>© 2026 Commons</span>
          </footer>
        </div>
      </aside>
      <nav className="mobile-nav" aria-label="モバイルナビゲーション">
        {mobileNavItems.map(({ id, icon: Icon }) => (
          <button
            key={id}
            className={id === "home" ? "active" : ""}
            onClick={id === "compose" && !user ? requireLogin : undefined}
          >
            <Icon size={23} />
          </button>
        ))}
      </nav>
      {visibleAuthMode && (
        <AuthModal
          mode={visibleAuthMode}
          error={actionData?.form === visibleAuthMode ? actionData.error : undefined}
          onClose={() => {
            setAuthMode(null);
            setDismissedAction(true);
          }}
          onChange={openAuth}
        />
      )}
    </main>
  );
}
