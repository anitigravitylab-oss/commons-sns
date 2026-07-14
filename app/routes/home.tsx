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
import { type ComponentProps, useEffect, useMemo, useRef, useState } from "react";
import { data, Form, redirect, useFetcher, useNavigate } from "react-router";
import type { Route } from "./+types/home";
import { cloudflareContext, type AppEnv } from "../cloudflare";
import {
  createSession,
  destroySession,
  findUserForLogin,
  getSessionUser,
  hashPassword,
  verifyPasswordOrDummy,
} from "../lib/auth.server";
import type { SessionUser } from "../lib/auth.server";
import { avatarClass, normalizeDate, timeAgo } from "../lib/post-presentation";
import { getTimeline } from "../lib/posts.server";
import type { TimelinePost } from "../lib/posts.server";
import { countCodePoints, isReservedHandle, sanitizeText, sliceCodePoints } from "../lib/text";

type ActionResult = {
  ok?: boolean;
  error?: string;
  form?: "login" | "signup";
};

type ActionFetcher = ReturnType<typeof useFetcher<ActionResult>>;

export function meta() {
  return [
    { title: "Commons — みんなで育てるSNS" },
    { name: "description", content: "中央集権型の、コミュニティ開発OSS SNS" },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = envFrom(context);
  const user = await getSessionUser(request, env);
  try {
    return { user, posts: await getTimeline(env, user?.id ?? null), timelineError: false };
  } catch (error) {
    console.error("getTimeline failed", error);
    return { user, posts: [] as TimelinePost[], timelineError: true };
  }
}

function envFrom(context: Route.LoaderArgs["context"]) {
  return context.get(cloudflareContext).env;
}

function formText(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

const fail = (error: string, status: number, form?: ActionResult["form"]) =>
  data<ActionResult>({ error, ...(form ? { form } : {}) }, { status });

const ok = () => data<ActionResult>({ ok: true });

export async function action({ request, context }: Route.ActionArgs) {
  const env = envFrom(context);
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    console.error("action formData failed", error);
    return fail("問題が発生しました。時間をおいてもう一度お試しください。", 500);
  }
  const intent = formText(formData, "intent");

  if (intent === "signup") return handleSignup(env, formData);
  if (intent === "login") return handleLogin(env, formData);
  if (intent === "logout") return handleLogout(env, request);

  const user = await getSessionUser(request, env);
  if (!user) return fail("この操作にはログインが必要です。", 401, "login");

  try {
    if (intent === "createPost") return await handleCreatePost(env, formData, user);
    if (intent === "toggleReaction") return await handleToggleReaction(env, formData, user);
    if (intent === "deletePost") return await handleDeletePost(env, formData, user);
  } catch (error) {
    console.error("action handler failed", error);
    return fail("問題が発生しました。時間をおいてもう一度お試しください。", 500);
  }

  return fail("不明な操作です。", 400);
}

async function handleSignup(env: AppEnv, formData: FormData) {
  const handle = formText(formData, "handle").toLowerCase().replace(/^@/, "");
  const displayName = sanitizeText(formText(formData, "displayName"));
  const password = String(formData.get("password") ?? "");
  if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
    return fail("IDは3〜20文字の半角英数字と_で入力してください。", 400, "signup");
  }
  if (isReservedHandle(handle)) {
    return fail("このIDは使用できません。", 400, "signup");
  }
  const displayNameLength = countCodePoints(displayName, 30);
  if (displayNameLength < 1 || displayNameLength > 30) {
    return fail("表示名は1〜30文字で入力してください。", 400, "signup");
  }
  if (password.length < 8 || password.length > 128) {
    return fail("パスワードは8〜128文字で入力してください。", 400, "signup");
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE|constraint/i.test(message)) {
      return fail("そのIDはすでに使われています。", 409, "signup");
    }
    console.error("handleSignup insert failed", error);
    return fail("登録できませんでした。時間をおいてもう一度お試しください。", 500, "signup");
  }
  return redirect("/", { headers: { "Set-Cookie": await createSession(env, userId) } });
}

async function handleLogin(env: AppEnv, formData: FormData) {
  const handle = formText(formData, "handle").toLowerCase().replace(/^@/, "");
  const password = String(formData.get("password") ?? "");
  if (password.length < 8 || password.length > 128) {
    return fail("IDまたはパスワードが違います。", 401, "login");
  }
  const user = await findUserForLogin(env, handle);
  const verified = await verifyPasswordOrDummy(password, user?.password_hash, user?.password_salt);
  if (!user || !verified) {
    return fail("IDまたはパスワードが違います。", 401, "login");
  }
  return redirect("/", { headers: { "Set-Cookie": await createSession(env, user.id) } });
}

async function handleLogout(env: AppEnv, request: Request) {
  return redirect("/", { headers: { "Set-Cookie": await destroySession(request, env) } });
}

async function handleCreatePost(env: AppEnv, formData: FormData, user: SessionUser) {
  const clean = sanitizeText(formText(formData, "body"), { multiline: true });
  if (!clean || countCodePoints(clean, 280) > 280) return fail("投稿は1〜280文字で入力してください。", 400);
  await env.DB.prepare("INSERT INTO posts (id, author_id, body, visibility) VALUES (?, ?, ?, 'public')")
    .bind(crypto.randomUUID(), user.id, clean)
    .run();
  return ok();
}

async function handleToggleReaction(env: AppEnv, formData: FormData, user: SessionUser) {
  const postId = formText(formData, "postId");
  const kind = formText(formData, "kind");
  if (!postId || !["like", "repost", "bookmark"].includes(kind)) {
    return fail("不正な操作です。", 400);
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
    await env.DB.prepare(
      `INSERT INTO post_reactions (user_id, post_id, kind)
       SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM posts WHERE id = ? AND deleted_at IS NULL)
       ON CONFLICT (user_id, post_id, kind) DO NOTHING`,
    )
      .bind(user.id, postId, kind, postId)
      .run();
  }
  return ok();
}

async function handleDeletePost(env: AppEnv, formData: FormData, user: SessionUser) {
  const postId = formText(formData, "postId");
  await env.DB.prepare(
    "UPDATE posts SET deleted_at = datetime('now') WHERE id = ? AND author_id = ? AND deleted_at IS NULL",
  )
    .bind(postId, user.id)
    .run();
  return ok();
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
  { id: "home", icon: Home, label: "ホーム" },
  { id: "search", icon: Search, label: "検索" },
  { id: "compose", icon: Feather, label: "投稿する" },
  { id: "notifications", icon: Bell, label: "通知" },
  { id: "profile", icon: UserRound, label: "プロフィール" },
];

function UserAvatar({ user, small = false }: { user: Pick<SessionUser, "displayName" | "handle">; small?: boolean }) {
  return (
    <div className={`avatar ${avatarClass(user.handle)}${small ? " small" : ""}`}>{sliceCodePoints(user.displayName, 1)}</div>
  );
}

type IntentFormProps = ComponentProps<typeof Form> & {
  intent: string;
  fields?: Record<string, string>;
  fetcher?: ActionFetcher;
};

function IntentForm({ intent, fields, fetcher, children, ...formProps }: IntentFormProps) {
  const body = (
    <>
      <input type="hidden" name="intent" value={intent} />
      {fields &&
        Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      {children}
    </>
  );
  if (fetcher) {
    return (
      <fetcher.Form method="post" action="?index" {...formProps}>
        {body}
      </fetcher.Form>
    );
  }
  return (
    <Form method="post" action="?index" {...formProps}>
      {body}
    </Form>
  );
}

/**
 * Renders a login or signup modal with authentication fields and controls.
 *
 * @param mode - The authentication mode to display.
 * @param error - An optional error message shown in the form.
 * @param onClose - Called when the modal is dismissed.
 * @param onChange - Called when the user switches authentication modes.
 */
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
  const dialogRef = useRef<HTMLDialogElement>(null);

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
  }, [mode]);

  return (
    <div className="modal-backdrop" role="presentation">
      <dialog
        ref={dialogRef}
        className="auth-modal"
        aria-labelledby="auth-title"
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
        <button className="modal-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
        <span className="brand-mark auth-brand">
          <span />
        </span>
        <h2 id="auth-title">{mode === "login" ? "Commonsにログイン" : "Commonsをはじめる"}</h2>
        <p>{mode === "login" ? "おかえりなさい。" : "メールアドレスなしですぐに登録できます。"}</p>
        <IntentForm intent={mode} className="auth-form">
          {mode === "signup" && (
            <label>
              表示名
              <input name="displayName" required autoComplete="name" placeholder="例：あおい" />
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
        </IntentForm>
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

  const remaining = 280 - countCodePoints(draft);

  return (
    <IntentForm fetcher={fetcher} intent="createPost" className="composer">
      <UserAvatar user={user} />
      <div className="composer-main">
        <textarea
          id="composer"
          name="body"
          value={draft}
          onChange={(event) => setDraft(sliceCodePoints(event.target.value, 280))}
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
            {draft.length > 0 && <span className={remaining < 20 ? "limit near" : "limit"}>{remaining}</span>}
            <button type="submit" disabled={!draft.trim() || fetcher.state !== "idle"}>
              {fetcher.state === "idle" ? "投稿する" : "送信中"}
            </button>
          </div>
        </div>
        {fetcher.data?.error && <div className="inline-error">{fetcher.data.error}</div>}
      </div>
    </IntentForm>
  );
}

type PostChildProps = {
  post: TimelinePost;
  user: SessionUser | null;
  onRequireLogin: () => void;
};

function ReactionButton({
  post,
  kind,
  user,
  onRequireLogin,
}: PostChildProps & { kind: "like" | "repost" | "bookmark" }) {
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
    <IntentForm fetcher={fetcher} intent="toggleReaction" fields={{ postId: post.id, kind }}>
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
    </IntentForm>
  );
}

function PostCard({ post, user, onRequireLogin }: PostChildProps) {
  const deleteFetcher = useFetcher<ActionResult>();
  return (
    <article className="post">
      <div className={`avatar ${avatarClass(post.handle)}`}>{sliceCodePoints(post.name, 1)}</div>
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
            <time dateTime={normalizeDate(post.createdAt)} suppressHydrationWarning>
              {timeAgo(post.createdAt)}
            </time>
          </div>
          {user?.id === post.authorId ? (
            <IntentForm fetcher={deleteFetcher} intent="deletePost" fields={{ postId: post.id }}>
              <button type="submit" aria-label="削除">
                <Trash2 size={17} />
              </button>
            </IntentForm>
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
  const { user, posts, timelineError } = loaderData;
  const navigate = useNavigate();
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
              <IntentForm intent="logout">
                <button className="icon-button" type="submit" aria-label="ログアウト">
                  <LogOut size={17} />
                </button>
              </IntentForm>
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
            {user ? sliceCodePoints(user.displayName, 1) : "?"}
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
          <span aria-live="polite">{activeTab}の投稿</span>
          <button>新しい順</button>
        </div>
        {timelineError && (
          <div className="form-error" role="alert">
            タイムラインを読み込めませんでした。時間をおいて再読み込みしてください。
          </div>
        )}
        <div className="posts">
          {visiblePosts.length === 0 && !timelineError ? (
            <div className="empty-state">
              <Search size={28} />
              <strong>投稿が見つかりません</strong>
              <span>
                {query
                  ? "検索は読み込み済みのタイムライン内のみが対象です。別の言葉でお試しください。"
                  : "最初の投稿をしてみましょう。"}
              </span>
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
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="タイムライン内を検索"
            />
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
              <button aria-label="トレンドの設定">
                <CircleEllipsis size={19} aria-hidden={true} />
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
        {mobileNavItems.map(({ id, icon: Icon, label }) => {
          const disabled = id === "search" || id === "notifications";
          const handleClick = () => {
            if (id === "home") {
              window.scrollTo({ top: 0, behavior: "smooth" });
            } else if (id === "compose") {
              if (user) document.querySelector<HTMLTextAreaElement>("#composer")?.focus();
              else requireLogin();
            } else if (id === "profile") {
              if (user) navigate("/profile");
              else requireLogin();
            }
          };
          return (
            <button
              key={id}
              className={id === "home" ? "active" : ""}
              aria-label={label}
              disabled={disabled}
              title={disabled ? "準備中" : undefined}
              onClick={disabled ? undefined : handleClick}
            >
              <Icon size={23} aria-hidden={true} />
            </button>
          );
        })}
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
