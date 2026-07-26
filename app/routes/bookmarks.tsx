import { Bookmark } from "lucide-react";
import { useEffect } from "react";
import { data, Link, redirect, useFetcher, useRevalidator } from "react-router";
import type { Route } from "./+types/bookmarks";
import { cloudflareContext } from "../cloudflare";
import { getSessionUser } from "../lib/auth.server";
import {
  cacheKeys,
  canSkipRevalidation,
  consumeBypass,
  markBypass,
  readCachedView,
  viewerHint,
  writeCachedView,
} from "../lib/client-cache";
import { PostSummaryCard } from "../lib/post-presentation";
import { getBookmarkedPosts, type TimelinePost } from "../lib/posts.server";
import { consumeToken, rateLimitResponseInit, RATE_LIMIT_MESSAGE } from "../lib/rate-limit.server";
import { crossSiteRejection, readFormDataBounded } from "../lib/request-guard.server";
import { SubpageShell } from "../lib/subpage";

type ActionResult = { ok?: boolean; error?: string };

export function meta() {
  return [{ title: "ブックマーク — Commons" }];
}

/** ブックマーク一覧の1ページあたり件数。 */
const BOOKMARK_PAGE_SIZE = 20;

/**
 * ブックマーク一覧の最大ページ番号。
 *
 * SQLite の OFFSET は読み飛ばす行も実際に走査するので、上限が無いと URL の `page` を
 * 大きくするだけで1リクエストの読み取り行数がその人のブックマーク総数まで伸びる。
 * 50 ページ ＝ 最大 1,000 件で頭打ちにする（以前は 100 件で頭打ちのうえ、
 * 101 件目以降へ到達する手段が UI にも URL にも無かった）。
 */
export const MAX_BOOKMARK_PAGE = 50;

/** URL のページ番号を 1〜{@link MAX_BOOKMARK_PAGE} の整数に正規化する。 */
function pageFromUrl(url: string) {
  const requested = Number.parseInt(new URL(url).searchParams.get("page") ?? "1", 10);
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(requested, MAX_BOOKMARK_PAGE);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await getSessionUser(request, env);
  if (!user) return redirect("/?auth=login");

  const page = pageFromUrl(request.url);

  let posts: TimelinePost[] = [];
  let hasNextPage = false;
  let bookmarksError = false;
  try {
    // 1件多く読んで「次のページがあるか」を判定する（COUNT(*) は撃たない）。
    const fetched = await getBookmarkedPosts(env, user.id, {
      limit: BOOKMARK_PAGE_SIZE + 1,
      offset: (page - 1) * BOOKMARK_PAGE_SIZE,
    });
    posts = fetched.slice(0, BOOKMARK_PAGE_SIZE);
    // 上限ページでは「次へ」を出さない（出しても pageFromUrl が同じページへ丸めるので、
    // 押しても同じ画面に戻る自己ループになる）。
    hasNextPage = fetched.length > BOOKMARK_PAGE_SIZE && page < MAX_BOOKMARK_PAGE;
  } catch (error) {
    console.error("Failed to load bookmarks", error);
    bookmarksError = true;
  }

  return { user, posts, page, hasNextPage, bookmarksError };
}

/** サーバーローダーが返す（シリアライズ済みの）ブックマークデータ。 */
type BookmarksData = Awaited<ReturnType<Route.ClientLoaderArgs["serverLoader"]>>;

/**
 * ブックマーク一覧を IndexedDB キャッシュ経由で読む（stale-while-revalidate）。
 * 判断は `app/routes/home.tsx` の clientLoader と同じ。
 */
export async function clientLoader({ request, serverLoader }: Route.ClientLoaderArgs) {
  const key = cacheKeys.bookmarks(pageFromUrl(request.url));

  const fetchFresh = async () => {
    const startedAt = Date.now();
    // 未ログインならサーバーローダーがリダイレクトを投げる。ここでは捕まえない。
    const fresh = await serverLoader();
    if (!fresh.bookmarksError) await writeCachedView(key, fresh.user.id, fresh, startedAt);
    return { ...fresh, cacheState: "network" as const };
  };

  if (consumeBypass(key)) return fetchFresh();

  const hint = viewerHint();
  const cached = await readCachedView<BookmarksData>(key, hint);
  if (!cached) return fetchFresh();

  // 未ログインの公開ページに限り再フェッチを省略する（理由は `canSkipRevalidation`）。
  if (canSkipRevalidation(hint, cached.savedAt)) {
    return { ...cached.payload, cacheState: "fresh-cache" as const };
  }
  markBypass(key);
  return { ...cached.payload, cacheState: "stale-cache" as const };
}
clientLoader.hydrate = false;

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
  const postId = String(formData.get("postId") ?? "").trim();
  if (intent !== "removeBookmark" || !postId) {
    return data<ActionResult>({ error: "不正な操作です。" }, { status: 400 });
  }

  // ブックマーク解除はリアクションと同じ枠を共有する。
  const verdict = consumeToken("reaction", user.id);
  if (!verdict.allowed) {
    return data<ActionResult>({ error: RATE_LIMIT_MESSAGE }, rateLimitResponseInit(verdict));
  }

  try {
    await env.DB.prepare("DELETE FROM post_reactions WHERE user_id = ? AND post_id = ? AND kind = 'bookmark'")
      .bind(user.id, postId)
      .run();
  } catch (error) {
    console.error("Failed to remove bookmark", error);
    return data<ActionResult>({ error: "ブックマークを解除できませんでした。" }, { status: 500 });
  }

  return data<ActionResult>({ ok: true });
}

function BookmarkCard({ post }: { post: TimelinePost }) {
  const fetcher = useFetcher<ActionResult>();
  const isRemoving = fetcher.state !== "idle";

  return (
    <PostSummaryCard
      post={post}
      action={
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="removeBookmark" />
          <input type="hidden" name="postId" value={post.id} />
          <button
            type="submit"
            disabled={isRemoving}
            className="bookmark-remove"
            aria-label="ブックマークから削除"
            title="ブックマークから削除"
          >
            <Bookmark size={18} fill="currentColor" />
          </button>
        </fetcher.Form>
      }
    >
      {fetcher.data?.error && (
        <div role="alert" className="inline-error">
          {fetcher.data.error}
        </div>
      )}
    </PostSummaryCard>
  );
}

export default function BookmarksPage({ loaderData }: Route.ComponentProps) {
  const { user, posts, page, hasNextPage, bookmarksError } = loaderData;
  const revalidator = useRevalidator();
  const cacheState = "cacheState" in loaderData ? loaderData.cacheState : undefined;
  const paged = page > 1 || hasNextPage;

  // 期限切れキャッシュを表示したときだけ、裏で最新を取り直す。
  useEffect(() => {
    if (cacheState === "stale-cache" && revalidator.state === "idle") void revalidator.revalidate();
  }, [cacheState, revalidator]);

  return (
    <SubpageShell
      heading={
        <>
          <h1>ブックマーク</h1>
          <p className="subpage-subtitle" aria-live="polite">
            @{user.handle}
            {/* 総件数は COUNT(*) を撃たないと出せない。ページが分かれているときは
                「このページの件数」を総数と誤読させないよう、ページ番号を出す。 */}
            {!bookmarksError && (paged ? ` · ${page}ページ目` : ` · ${posts.length}件`)}
          </p>
        </>
      }
    >
      {bookmarksError ? (
        <div className="form-error subpage-alert" role="alert">
          ブックマークを読み込めませんでした。時間をおいて再読み込みしてください。
        </div>
      ) : posts.length === 0 ? (
        <div className="empty-state tall">
          <Bookmark size={30} />
          <strong>{page > 1 ? "このページにはブックマークがありません" : "ブックマークはまだありません"}</strong>
          {page > 1 ? (
            <Link to="?page=1">最初のページへ戻る</Link>
          ) : (
            <>
              <span>投稿のブックマークボタンを押すと、ここであとから確認できます。</span>
              <Link to="/">投稿を見に行く</Link>
            </>
          )}
        </div>
      ) : (
        posts.map((post) => <BookmarkCard key={post.id} post={post} />)
      )}

      {paged && (
        <nav aria-label="ブックマークのページ移動" className="pager">
          {page > 1 ? <Link to={`?page=${page - 1}`}>← 前へ</Link> : <span />}
          {hasNextPage && <Link to={`?page=${page + 1}`}>次へ →</Link>}
        </nav>
      )}
    </SubpageShell>
  );
}
