import { UsersRound } from "lucide-react";
import { useEffect } from "react";
import { data, Link, redirect, useFetcher, useLocation, useRevalidator } from "react-router";
import type { Route } from "./+types/follow-list";
import { cloudflareContext } from "../cloudflare";
import { getSessionUser } from "../lib/auth.server";
import {
  cacheKeys,
  canSkipRevalidation,
  consumeBypass,
  GUEST_OWNER,
  markBypass,
  readCachedView,
  viewerHint,
  writeCachedView,
} from "../lib/client-cache";
import { UserAvatar } from "../lib/post-presentation";
import { consumeToken, rateLimitResponseInit, RATE_LIMIT_MESSAGE } from "../lib/rate-limit.server";
import { crossSiteRejection, readFormDataBounded } from "../lib/request-guard.server";
import { SubpageShell } from "../lib/subpage";
import {
  FOLLOW_LIST_PAGE_SIZE,
  getFollowList,
  getUserProfileByHandle,
  toggleFollow,
  type FollowListEntry,
  type FollowListKind,
} from "../lib/users.server";

type ActionResult = { ok?: boolean; error?: string };

export function meta() {
  return [{ title: "フォロー — Commons" }];
}

function handleFromParams(params: Route.LoaderArgs["params"]) {
  return String(params.handle ?? "")
    .trim()
    .replace(/^@/, "");
}

/**
 * URL の末尾から一覧の種別を決める。
 *
 * `users/:handle/following` と `users/:handle/followers` は同じモジュールを使うので、
 * loader・clientLoader・action のどこからでも同じ規則で判定できる形にしている
 * （`route.id` はクライアント側の判定に持ち込めない）。
 *
 * **`.data` と末尾スラッシュを必ず落とすこと。** 素の `endsWith` だと、
 * どちらも「フォロワー」と誤判定して URL と中身が食い違う。
 *
 * - `.data`: クライアント遷移では React Router が
 *   `/users/x/following.data?_routes=following` を取りに行く
 * - 末尾スラッシュ: `/users/x/following/` もこのルートにマッチする（実測で 200 を返す）
 */
function kindFromUrl(url: string): FollowListKind {
  const path = new URL(url).pathname.replace(/\.data$/, "").replace(/\/+$/, "");
  return path.endsWith("/following") ? "following" : "followers";
}

/**
 * フォロー一覧の最大ページ番号（OFFSET 走査の頭打ち）。
 *
 * `app/lib/users.server.ts` にも同じ値があるが、そちらは**サーバー専用モジュール**で、
 * この値は `clientLoader`（キャッシュキーの組み立て）からも読むためここに置く。
 * `MAX_PROFILE_PAGE` を `app/routes/profile.tsx` に置いているのと同じ理由。
 * 2つの値が食い違わないことは `follow-list.server.test.ts` が固定する。
 */
export const MAX_FOLLOW_LIST_PAGE = 25;

/** URL のページ番号を 1〜{@link MAX_FOLLOW_LIST_PAGE} の整数に正規化する。 */
function pageFromUrl(url: string) {
  const requested = Number.parseInt(new URL(url).searchParams.get("page") ?? "1", 10);
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(requested, MAX_FOLLOW_LIST_PAGE);
}

/**
 * フォロー中／フォロワーの一覧。
 *
 * 未ログインでも読める（プロフィールと同じく公開情報）。相互バッジとフォロー
 * ボタンは閲覧者がログインしているときだけ出す。
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const [profile, user] = await Promise.all([
    getUserProfileByHandle(env, handleFromParams(params)),
    getSessionUser(request, env),
  ]);
  if (!profile) throw data(null, { status: 404 });

  const kind = kindFromUrl(request.url);
  const page = pageFromUrl(request.url);

  let entries: FollowListEntry[] = [];
  let hasNextPage = false;
  let listError = false;
  try {
    const result = await getFollowList(env, profile.id, kind, user?.id ?? null, {
      limit: FOLLOW_LIST_PAGE_SIZE,
      offset: (page - 1) * FOLLOW_LIST_PAGE_SIZE,
    });
    entries = result.entries;
    // 上限ページでは「次へ」を出さない（出しても pageFromUrl が同じページへ丸める）。
    hasNextPage = result.hasNextPage && page < MAX_FOLLOW_LIST_PAGE;
  } catch (error) {
    console.error("Failed to load follow list", error);
    listError = true;
  }

  return { user, profile, kind, page, entries, hasNextPage, listError };
}

/** サーバーローダーが返す（シリアライズ済みの）フォロー一覧データ。 */
type FollowListData = Awaited<ReturnType<Route.ClientLoaderArgs["serverLoader"]>>;

/**
 * フォロー一覧を IndexedDB キャッシュ経由で読む（stale-while-revalidate）。
 * 変化が遅い一覧なので効果が大きい。判断は `app/routes/home.tsx` の clientLoader と同じ。
 */
export async function clientLoader({ request, params, serverLoader }: Route.ClientLoaderArgs) {
  const key = cacheKeys.followList(handleFromParams(params), kindFromUrl(request.url), pageFromUrl(request.url));

  const fetchFresh = async () => {
    const startedAt = Date.now();
    // 存在しないハンドルではサーバーローダーが 404 を投げる。ここでは捕まえない。
    const fresh = await serverLoader();
    if (!fresh.listError) await writeCachedView(key, fresh.user?.id ?? GUEST_OWNER, fresh, startedAt);
    return { ...fresh, cacheState: "network" as const };
  };

  if (consumeBypass(key)) return fetchFresh();

  const hint = viewerHint();
  const cached = await readCachedView<FollowListData>(key, hint);
  if (!cached) return fetchFresh();

  // 未ログインの公開ページに限り再フェッチを省略する（理由は `canSkipRevalidation`）。
  if (canSkipRevalidation(hint, cached.savedAt)) {
    return { ...cached.payload, cacheState: "fresh-cache" as const };
  }
  markBypass(key);
  return { ...cached.payload, cacheState: "stale-cache" as const };
}
clientLoader.hydrate = false;

/**
 * 一覧の行からフォロー／解除する。
 *
 * 対象はプロフィールのハンドルではなく行の利用者 ID なので、`targetId` をフォーム値で受ける。
 * 存在しない ID は `toggleFollow` の EXISTS ガードが吸収する（例外にしない）。
 */
export async function action({ request, context }: Route.ActionArgs) {
  // クロスサイト送信と過大な本文は、セッションを引く前に落とす（`request-guard.server.ts`）。
  const rejected = crossSiteRejection(request);
  if (rejected) return rejected;

  const { env } = context.get(cloudflareContext);
  const user = await getSessionUser(request, env);
  if (!user) return redirect("/?auth=login");

  const body = await readFormDataBounded(request);
  if (!body.ok) return data<ActionResult>({ error: body.message }, { status: body.status });
  const formData = body.formData;

  const intent = String(formData.get("intent") ?? "");
  const targetId = String(formData.get("targetId") ?? "").trim();
  if (intent !== "toggleFollow" || !targetId) {
    return data<ActionResult>({ error: "不正な操作です。" }, { status: 400 });
  }
  if (targetId === user.id) {
    return data<ActionResult>({ error: "自分をフォローすることはできません。" }, { status: 400 });
  }

  const verdict = consumeToken("follow", user.id);
  if (!verdict.allowed) {
    return data<ActionResult>({ error: RATE_LIMIT_MESSAGE }, rateLimitResponseInit(verdict));
  }

  try {
    await toggleFollow(env, user.id, targetId);
  } catch (error) {
    console.error("Failed to toggle follow", error);
    return data<ActionResult>({ error: "フォロー状態を変更できませんでした。" }, { status: 500 });
  }
  return data<ActionResult>({ ok: true });
}

function EntryFollowButton({ entry }: { entry: FollowListEntry }) {
  const fetcher = useFetcher<ActionResult>();
  // 送信中は切り替え後の状態を先に見せる（再検証がサーバーの真実で上書きする）。
  const pending = fetcher.state !== "idle";
  const shownFollowing = pending ? !entry.viewerFollows : entry.viewerFollows;
  return (
    <div className="follow-control">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="toggleFollow" />
        <input type="hidden" name="targetId" value={entry.id} />
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

function FollowRow({
  entry,
  viewerId,
  followsViewer,
}: {
  entry: FollowListEntry;
  viewerId: string | null;
  /** この行の利用者が閲覧者をフォローしているか（自分のフォロワー一覧でのみ真になりうる）。 */
  followsViewer: boolean;
}) {
  const location = useLocation();
  return (
    <article className="follow-entry">
      <Link
        to={`/users/${encodeURIComponent(entry.handle)}`}
        state={location.state}
        className="follow-entry-link"
        discover="none"
      >
        <UserAvatar name={entry.displayName} handle={entry.handle} avatarKey={entry.avatarKey} />
        <span className="follow-entry-identity">
          <strong>{entry.displayName}</strong>
          <small>@{entry.handle}</small>
          {followsViewer && <span className="follow-entry-badge">フォローされています</span>}
        </span>
      </Link>
      {viewerId && viewerId !== entry.id && <EntryFollowButton key={String(entry.viewerFollows)} entry={entry} />}
      {entry.bio && <p className="follow-entry-bio">{entry.bio}</p>}
    </article>
  );
}

export default function FollowListPage({ loaderData }: Route.ComponentProps) {
  const { user, profile, kind, page, entries, hasNextPage, listError } = loaderData;
  const location = useLocation();
  const revalidator = useRevalidator();
  const cacheState = "cacheState" in loaderData ? loaderData.cacheState : undefined;

  // 期限切れキャッシュを表示したときだけ、裏で最新を取り直す。
  useEffect(() => {
    if (cacheState === "stale-cache" && revalidator.state === "idle") void revalidator.revalidate();
  }, [cacheState, revalidator]);

  const title = kind === "following" ? `@${profile.handle} がフォロー中` : `@${profile.handle} のフォロワー`;
  const total = kind === "following" ? profile.followingCount : profile.followerCount;
  // 自分のフォロワー一覧に並ぶ相手は、定義上こちらをフォローしている（追加クエリ 0）。
  const followersOfViewer = kind === "followers" && user?.id === profile.id;

  return (
    <SubpageShell
      heading={
        <>
          <h1>{title}</h1>
          <p className="subpage-subtitle">{total}人</p>
        </>
      }
    >
      <div className="tabs follow-list-tabs" role="tablist">
        <Link
          role="tab"
          aria-selected={kind === "following"}
          className={kind === "following" ? "tab active" : "tab"}
          to={`/users/${encodeURIComponent(profile.handle)}/following`}
          state={location.state}
          discover="none"
        >
          フォロー中
        </Link>
        <Link
          role="tab"
          aria-selected={kind === "followers"}
          className={kind === "followers" ? "tab active" : "tab"}
          to={`/users/${encodeURIComponent(profile.handle)}/followers`}
          state={location.state}
          discover="none"
        >
          フォロワー
        </Link>
      </div>

      {listError ? (
        <div className="form-error subpage-alert" role="alert">
          一覧を読み込めませんでした。時間をおいて再読み込みしてください。
        </div>
      ) : entries.length === 0 ? (
        <div className="empty-state tall">
          <UsersRound size={30} />
          <strong>
            {page > 1
              ? "このページには誰もいません"
              : kind === "following"
                ? "まだ誰もフォローしていません"
                : "フォロワーはまだいません"}
          </strong>
          {page > 1 && (
            <Link to="?page=1" state={location.state}>
              最初のページへ戻る
            </Link>
          )}
        </div>
      ) : (
        <div className="follow-list">
          {entries.map((entry) => (
            <FollowRow
              key={entry.id}
              entry={entry}
              viewerId={user?.id ?? null}
              // 自分のフォロワー一覧なら、並んでいる全員が定義上こちらをフォローしている。
              // 「相手が自分をフォローしているか」を行ごとに引くクエリは撃たない。
              followsViewer={followersOfViewer}
            />
          ))}
        </div>
      )}

      {(page > 1 || hasNextPage) && (
        <nav aria-label="一覧のページ移動" className="pager">
          {page > 1 ? (
            <Link to={`?page=${page - 1}`} state={location.state}>
              ← 前へ
            </Link>
          ) : (
            <span />
          )}
          {hasNextPage && (
            <Link to={`?page=${page + 1}`} state={location.state}>
              次へ →
            </Link>
          )}
        </nav>
      )}
    </SubpageShell>
  );
}
