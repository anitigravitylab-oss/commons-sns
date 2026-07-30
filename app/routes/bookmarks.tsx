import { Bookmark } from "lucide-react";
import { data, Link, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/bookmarks";
import { cloudflareContext } from "../cloudflare";
import { getSessionUser } from "../lib/auth.server";
import { PostSummaryCard } from "../lib/post-presentation";
import { getBookmarkedPosts, type TimelinePost } from "../lib/posts.server";
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

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await getSessionUser(request, env);
  if (!user) return redirect("/?auth=login");

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const postId = String(formData.get("postId") ?? "").trim();
  if (intent !== "removeBookmark" || !postId) {
    return data<ActionResult>({ error: "不正な操作です。" }, { status: 400 });
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
  const paged = page > 1 || hasNextPage;

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
