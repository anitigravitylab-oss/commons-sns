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
