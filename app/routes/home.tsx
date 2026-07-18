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
  type LucideIcon,
} from "lucide-react";
import { type ComponentProps, useEffect, useMemo, useRef, useState } from "react";
import { data, Form, Link, redirect, useFetcher, useNavigate, useRevalidator, useSearchParams } from "react-router";
import type { Route } from "./+types/home";
import { cloudflareContext, type AppEnv } from "../cloudflare";
import { resolveAutoReloadMs } from "../lib/auto-reload";
import {
  createSession,
  destroySession,
  findUserForLogin,
  getSessionUser,
  hashPassword,
  verifyPasswordOrDummy,
} from "../lib/auth.server";
import type { SessionUser } from "../lib/auth.server";
import { avatarClass, PostIdentity, UserAvatar } from "../lib/post-presentation";
import { getTimeline } from "../lib/posts.server";
import type { TimelinePost, TimelineScope } from "../lib/posts.server";
import { countCodePoints, isReservedHandle, sanitizeText, sliceCodePoints } from "../lib/text";

type ActionResult = {
  ok?: boolean;
  error?: string;
  form?: "login" | "signup";
};

type ActionFetcher = ReturnType<typeof useFetcher<ActionResult>>;

const POST_MAX_LENGTH = 280;
const PROJECT_REPO_URL = "https://github.com/anitigravitylab-oss/commons-sns";

export function meta() {
  return [
    { title: "Commons — みんなで育てるSNS" },
    { name: "description", content: "中央集権型の、コミュニティ開発OSS SNS" },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await getSessionUser(request, env);
  const url = new URL(request.url);
  const requestedTab = url.searchParams.get("tab");
  const tab: TimelineScope = requestedTab === "following" && user ? "following" : "recommended";
  // dev 限定のタイムライン自動更新間隔（ローカル開発用・本番では常に 0）。
  // `.dev.vars` の COMMONS_LOCAL_AUTO_RELOAD_MS で設定。push 配信（SSE/WebSocket）導入時に削除する。
  const autoReloadMs = resolveAutoReloadMs({
    isDev: import.meta.env.DEV,
    envValue: env.COMMONS_LOCAL_AUTO_RELOAD_MS,
    queryValue: url.searchParams.get("autoReloadMs"),
  });
  try {
    return { user, tab, posts: await getTimeline(env, user?.id ?? null, tab), timelineError: false, autoReloadMs };
  } catch (error) {
    console.error("getTimeline failed", error);
    return { user, tab, posts: [] as TimelinePost[], timelineError: true, autoReloadMs };
  }
}

function formText(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

const fail = (error: string, status: number, form?: ActionResult["form"]) =>
  data<ActionResult>({ error, ...(form ? { form } : {}) }, { status });

const ok = () => data<ActionResult>({ ok: true });

export async function action({ request, context }: Route.ActionArgs) {
  const { env, ctx } = context.get(cloudflareContext);
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    console.error("action formData failed", error);
    return fail("問題が発生しました。時間をおいてもう一度お試しください。", 500);
  }
  const intent = formText(formData, "intent");
  const authForm = intent === "signup" ? "signup" : intent === "login" ? "login" : undefined;

  try {
    if (intent === "signup") return await handleSignup(env, ctx, formData);
    if (intent === "login") return await handleLogin(env, ctx, formData);
    if (intent === "logout") return await handleLogout(env, request);

    const user = await getSessionUser(request, env);
    if (!user) return fail("この操作にはログインが必要です。", 401, "login");

    if (intent === "createPost") return await handleCreatePost(env, formData, user);
    if (intent === "toggleReaction") return await handleToggleReaction(env, formData, user);
    if (intent === "deletePost") return await handleDeletePost(env, formData, user);
  } catch (error) {
    console.error("action handler failed", error);
    return fail("問題が発生しました。時間をおいてもう一度お試しください。", 500, authForm);
  }

  return fail("不明な操作です。", 400);
}

async function handleSignup(env: AppEnv, ctx: ExecutionContext, formData: FormData) {
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
  return redirect("/", { headers: { "Set-Cookie": await createSession(env, userId, ctx) } });
}

async function handleLogin(env: AppEnv, ctx: ExecutionContext, formData: FormData) {
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
  return redirect("/", { headers: { "Set-Cookie": await createSession(env, user.id, ctx) } });
}

async function handleLogout(env: AppEnv, request: Request) {
  return redirect("/", { headers: { "Set-Cookie": await destroySession(request, env) } });
}

async function handleCreatePost(env: AppEnv, formData: FormData, user: SessionUser) {
  const clean = sanitizeText(formText(formData, "body"), { multiline: true });
  if (!clean || countCodePoints(clean, POST_MAX_LENGTH) > POST_MAX_LENGTH) {
    return fail(`投稿は1〜${POST_MAX_LENGTH}文字で入力してください。`, 400);
  }
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
  // Delete first and only insert when nothing was removed: one round trip per
  // toggle, and concurrent toggles cannot double-insert thanks to ON CONFLICT.
  const deleted = await env.DB.prepare("DELETE FROM post_reactions WHERE user_id = ? AND post_id = ? AND kind = ?")
    .bind(user.id, postId, kind)
    .run();
  if ((deleted.meta.changes ?? 0) === 0) {
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

type NavEntry = {
  label: string;
  icon: LucideIcon;
  to?: string;
  requiresAuth?: boolean;
};

const navItems: NavEntry[] = [
  { label: "ホーム", icon: Home, to: "/" },
  { label: "見つける", icon: Search },
  { label: "通知", icon: Bell },
  { label: "メッセージ", icon: Mail },
  { label: "ブックマーク", icon: Bookmark, to: "/bookmarks", requiresAuth: true },
  { label: "コミュニティ", icon: UsersRound },
  { label: "プロフィール", icon: UserRound, to: "/profile", requiresAuth: true },
  { label: "設定", icon: Settings, to: "/settings", requiresAuth: true },
];

const mobileNavItems = [
  { id: "home", icon: Home, label: "ホーム" },
  { id: "search", icon: Search, label: "検索" },
  { id: "compose", icon: Feather, label: "投稿する" },
  { id: "bookmarks", icon: Bookmark, label: "ブックマーク" },
  { id: "profile", icon: UserRound, label: "プロフィール" },
];

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

  // The draft is never truncated while typing — cutting the value mid-input
  // breaks IME composition. Overlong drafts just disable submission instead.
  const remaining = POST_MAX_LENGTH - countCodePoints(draft);
  const over = remaining < 0;

  return (
    <IntentForm fetcher={fetcher} intent="createPost" className="composer">
      <UserAvatar name={user.displayName} handle={user.handle} />
      <div className="composer-main">
        <textarea
          id="composer"
          name="body"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
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
              <span className={over ? "limit over" : remaining < 20 ? "limit near" : "limit"}>{remaining}</span>
            )}
            <button type="submit" disabled={!draft.trim() || over || fetcher.state !== "idle"}>
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
  const baseCount = kind === "like" ? post.likes : kind === "repost" ? post.reposts : undefined;
  const Icon = kind === "like" ? Heart : kind === "repost" ? Repeat2 : Bookmark;
  const label = kind === "like" ? "いいね" : kind === "repost" ? "リポスト" : "ブックマーク";
  if (!user)
    return (
      <button onClick={onRequireLogin} aria-label={label}>
        <span>
          <Icon size={18} />
        </span>
        {baseCount !== undefined && <small>{baseCount || ""}</small>}
      </button>
    );
  // Show the toggled state optimistically while the submission is in flight;
  // revalidation replaces it with the server truth right after.
  const pending = fetcher.state !== "idle";
  const shownActive = pending ? !active : active;
  const count = baseCount === undefined ? undefined : Math.max(0, baseCount + (pending ? (active ? -1 : 1) : 0));
  const activeClass = kind === "like" ? "liked" : kind === "repost" ? "reposted" : "bookmarked";
  return (
    <IntentForm fetcher={fetcher} intent="toggleReaction" fields={{ postId: post.id, kind }}>
      <button
        type="submit"
        disabled={pending}
        className={shownActive ? activeClass : ""}
        aria-label={label}
        aria-pressed={shownActive}
      >
        <span>
          <Icon size={18} fill={shownActive && kind !== "repost" ? "currentColor" : "none"} />
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
      <UserAvatar name={post.name} handle={post.handle} />
      <div className="post-content">
        <header>
          <PostIdentity name={post.name} handle={post.handle} createdAt={post.createdAt} />
          {user?.id === post.authorId ? (
            <IntentForm fetcher={deleteFetcher} intent="deletePost" fields={{ postId: post.id }}>
              <button type="submit" disabled={deleteFetcher.state !== "idle"} aria-label="投稿を削除">
                <Trash2 size={17} />
              </button>
            </IntentForm>
          ) : (
            <button aria-label="その他" title="準備中">
              <MoreHorizontal size={19} />
            </button>
          )}
        </header>
        <p>{post.body}</p>
        <footer className="post-actions">
          <button onClick={user ? undefined : onRequireLogin} aria-label="返信" title="返信機能は準備中です">
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
  const { user, posts, tab, timelineError, autoReloadMs } = loaderData;
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const authParam = searchParams.get("auth");
  const [authMode, setAuthMode] = useState<"login" | "signup" | null>(
    authParam === "login" || authParam === "signup" ? authParam : null,
  );
  const [dismissedError, setDismissedError] = useState(false);

  // A new action response may carry a fresh auth error; let it show again.
  useEffect(() => {
    if (actionData) setDismissedError(false);
  }, [actionData]);

  // Close the auth modal once a login or signup succeeds.
  const userId = user?.id;
  useEffect(() => {
    if (userId) setAuthMode(null);
  }, [userId]);

  // dev 限定: タイムラインを定期的に再検証する。本番ビルドでは import.meta.env.DEV が
  // false 定数となり、この effect の中身は minify で dead code 化する。
  // visibilityState でバックグラウンドタブの無駄なポーリングを防ぐ。
  // revalidator.state の確認で、取得が間に合わないときの重複再検証を防ぐ。
  // push 配信（SSE/WebSocket）導入時に削除する。
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (!autoReloadMs) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") {
        void revalidator.revalidate();
      }
    }, autoReloadMs);
    return () => window.clearInterval(timer);
  }, [autoReloadMs, revalidator]);

  const visiblePosts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return posts;
    return posts.filter((post) => `${post.name} ${post.handle} ${post.body}`.toLowerCase().includes(normalized));
  }, [posts, query]);

  const openAuth = (mode: "login" | "signup") => setAuthMode(mode);
  const requireLogin = () => openAuth("login");
  const closeAuth = () => {
    setAuthMode(null);
    setDismissedError(true);
    if (searchParams.has("auth")) {
      const next = new URLSearchParams(searchParams);
      next.delete("auth");
      setSearchParams(next, { replace: true, preventScrollReset: true });
    }
  };
  const visibleAuthMode = user ? null : (authMode ?? (dismissedError ? null : (actionData?.form ?? null)));

  const focusComposer = () => document.querySelector<HTMLTextAreaElement>("#composer")?.focus();

  // サブページの「タイムラインへ戻る」リンクが選択中のタブへ戻れるようにする。
  const backToTimeline = tab === "following" ? "/?tab=following" : "/";
  const subpageState = { backTo: backToTimeline };
  // /profile はloaderのredirect先へ state を引き継げないため、直接プロフィールURLへ。
  const profileTo = user ? `/users/${encodeURIComponent(user.handle)}` : "/profile";
  const emptyState = query
    ? {
        icon: Search,
        title: "投稿が見つかりません",
        description: "検索は読み込み済みのタイムライン内のみが対象です。別の言葉でお試しください。",
      }
    : tab === "following"
      ? {
          icon: UsersRound,
          title: "まだ投稿がありません",
          description: "ユーザーをフォローすると、その投稿がここに表示されます。",
        }
      : { icon: Search, title: "投稿が見つかりません", description: "最初の投稿をしてみましょう。" };
  const EmptyIcon = emptyState.icon;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-inner">
          <button className="brand" aria-label="Commons ホーム" onClick={() => navigate("/")}>
            <span className="brand-mark">
              <span />
            </span>
            <span className="brand-name">Commons</span>
            <span className="brand-beta">BETA</span>
          </button>
          <nav className="main-nav" aria-label="メインナビゲーション">
            {navItems.map(({ label, icon: Icon, to, requiresAuth }) => {
              const isCurrent = to === "/";
              const content = (
                <>
                  <span className="nav-icon-wrap">
                    <Icon size={23} strokeWidth={isCurrent ? 2.5 : 1.9} />
                  </span>
                  <span>{label}</span>
                </>
              );
              if (!to) {
                return (
                  <button key={label} className="nav-item" disabled title="準備中">
                    {content}
                  </button>
                );
              }
              if (requiresAuth && !user) {
                return (
                  <button key={label} className="nav-item" onClick={requireLogin}>
                    {content}
                  </button>
                );
              }
              return (
                <Link
                  key={label}
                  className={isCurrent ? "nav-item active" : "nav-item"}
                  to={to === "/profile" ? profileTo : to}
                  state={subpageState}
                >
                  {content}
                </Link>
              );
            })}
          </nav>
          <button className="post-button" onClick={() => (user ? focusComposer() : requireLogin())}>
            <Feather size={19} />
            <span>投稿する</span>
          </button>
          {user ? (
            <div className="account-switcher">
              <UserAvatar name={user.displayName} handle={user.handle} className="small" />
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
            <Link
              role="tab"
              aria-selected={tab === "recommended"}
              className={tab === "recommended" ? "tab active" : "tab"}
              to="/"
            >
              おすすめ
            </Link>
            {user ? (
              <Link
                role="tab"
                aria-selected={tab === "following"}
                className={tab === "following" ? "tab active" : "tab"}
                to="/?tab=following"
              >
                フォロー中
              </Link>
            ) : (
              <button role="tab" aria-selected={false} className="tab" onClick={requireLogin}>
                フォロー中
              </button>
            )}
          </div>
          <button
            className={`mobile-avatar avatar ${user ? avatarClass(user.handle) : "avatar-dark"}`}
            onClick={() => (user ? navigate(profileTo, { state: subpageState }) : requireLogin())}
            aria-label={user ? "プロフィール" : "ログイン"}
          >
            {user ? sliceCodePoints(user.displayName, 1) : "?"}
          </button>
        </header>
        <div className="topic-strip">
          <Sparkles size={15} />
          <span>いま話されていること</span>
          <strong>みんなで決める最初の機能</strong>
          <a className="topic-action" href={PROJECT_REPO_URL} target="_blank" rel="noreferrer">
            参加する
          </a>
        </div>
        <Composer user={user} onRequireLogin={requireLogin} />
        <div className="feed-status">
          <span aria-live="polite">{tab === "following" ? "フォロー中" : "おすすめ"}の投稿</span>
          <span>新しい順</span>
        </div>
        {timelineError && (
          <div className="form-error" role="alert">
            タイムラインを読み込めませんでした。時間をおいて再読み込みしてください。
          </div>
        )}
        <div className="posts">
          {visiblePosts.length === 0 && !timelineError ? (
            <div className="empty-state">
              <EmptyIcon size={28} />
              <strong>{emptyState.title}</strong>
              <span>{emptyState.description}</span>
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
            <a className="project-link" href={PROJECT_REPO_URL} target="_blank" rel="noreferrer">
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
            <a href={PROJECT_REPO_URL}>ソースコード</a>
            <a href={`${PROJECT_REPO_URL}/blob/main/LICENSE`}>AGPL-3.0</a>
            <span>© 2026 Commons</span>
          </footer>
        </div>
      </aside>
      <nav className="mobile-nav" aria-label="モバイルナビゲーション">
        {mobileNavItems.map(({ id, icon: Icon, label }) => {
          const disabled = id === "search";
          const handleClick = () => {
            if (id === "home") {
              window.scrollTo({ top: 0, behavior: "smooth" });
            } else if (id === "compose") {
              if (user) focusComposer();
              else requireLogin();
            } else if (id === "bookmarks") {
              if (user) navigate("/bookmarks", { state: subpageState });
              else requireLogin();
            } else if (id === "profile") {
              if (user) navigate(profileTo, { state: subpageState });
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
          error={!dismissedError && actionData?.form === visibleAuthMode ? actionData.error : undefined}
          onClose={closeAuth}
          onChange={openAuth}
        />
      )}
    </main>
  );
}
