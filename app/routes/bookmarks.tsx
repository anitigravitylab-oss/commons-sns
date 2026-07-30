import { Bookmark } from "lucide-react";
import { data, Link, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/bookmarks";
import { cloudflareContext } from "../cloudflare";
import { getSessionUser } from "../lib/auth.server";
import { PostSummaryCard } from "../lib/post-presentation";
import { getBookmarkedPosts, type TimelinePost } from "../lib/posts.server";
import { consumeToken, rateLimitResponseInit, RATE_LIMIT_MESSAGE } from "../lib/rate-limit.server";
import { crossSiteRejection, readFormDataBounded } from "../lib/request-guard.server";
import { SubpageShell } from "../lib/subpage";

type ActionResult = { ok?: boolean; error?: string };

export function meta() {
  return [{ title: "ブックマーク — Commons" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await getSessionUser(request, env);
  if (!user) return redirect("/?auth=login");

  let posts: TimelinePost[] = [];
  let bookmarksError = false;
  try {
    posts = await getBookmarkedPosts(env, user.id);
  } catch (error) {
    console.error("Failed to load bookmarks", error);
    bookmarksError = true;
  }

  return { user, posts, bookmarksError };
}

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
  const { user, posts, bookmarksError } = loaderData;

  return (
    <SubpageShell
      heading={
        <>
          <h1>ブックマーク</h1>
          <p className="subpage-subtitle" aria-live="polite">
            @{user.handle}
            {!bookmarksError && ` · ${posts.length}件`}
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
          <strong>ブックマークはまだありません</strong>
          <span>投稿のブックマークボタンを押すと、ここであとから確認できます。</span>
          <Link to="/">投稿を見に行く</Link>
        </div>
      ) : (
        posts.map((post) => <BookmarkCard key={post.id} post={post} />)
      )}
    </SubpageShell>
  );
}
