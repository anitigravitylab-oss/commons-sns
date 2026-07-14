import { Bookmark } from "lucide-react";
import { data, Link, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/bookmarks";
import { cloudflareContext } from "../cloudflare";
import { getSessionUser } from "../lib/auth.server";
import { avatarClass, PostIdentity, PostReactionCounts } from "../lib/post-presentation";
import { getBookmarkedPosts, type TimelinePost } from "../lib/posts.server";
import { sliceCodePoints } from "../lib/text";

type ActionResult = { ok?: boolean; error?: string };

export function meta() {
  return [{ title: "ブックマーク — Commons" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await getSessionUser(request, env);
  if (!user) return redirect("/");

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
  if (!user) return redirect("/");

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
    <article
      style={{
        display: "grid",
        gridTemplateColumns: "42px minmax(0, 1fr)",
        gap: 12,
        padding: "18px 18px 14px",
        borderBottom: "1px solid #e7e9ed",
        background: "white",
      }}
    >
      <div className={`avatar ${avatarClass(post.handle)}`}>{sliceCodePoints(post.name, 1)}</div>
      <div style={{ minWidth: 0 }}>
        <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <PostIdentity name={post.name} handle={post.handle} createdAt={post.createdAt} />
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="removeBookmark" />
            <input type="hidden" name="postId" value={post.id} />
            <button
              type="submit"
              disabled={isRemoving}
              aria-label="ブックマークから削除"
              title="ブックマークから削除"
              style={{
                width: 34,
                height: 34,
                border: 0,
                borderRadius: 9,
                display: "grid",
                placeItems: "center",
                background: isRemoving ? "#f1f3f6" : "#eef4ff",
                color: "#2867e8",
                cursor: isRemoving ? "wait" : "pointer",
                opacity: isRemoving ? 0.6 : 1,
              }}
            >
              <Bookmark size={18} fill="currentColor" />
            </button>
          </fetcher.Form>
        </header>
        <p style={{ margin: "8px 0 13px", lineHeight: 1.65, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {post.body}
        </p>
        <PostReactionCounts replies={post.replies} reposts={post.reposts} likes={post.likes} />
        {fetcher.data?.error && (
          <div role="alert" className="inline-error" style={{ marginTop: 10 }}>
            {fetcher.data.error}
          </div>
        )}
      </div>
    </article>
  );
}

export default function BookmarksPage({ loaderData }: Route.ComponentProps) {
  const { user, posts, bookmarksError } = loaderData;

  return (
    <main style={{ minHeight: "100vh", background: "#fff" }}>
      <section
        style={{
          width: "min(100%, 640px)",
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
            padding: "16px 18px 14px",
            borderBottom: "1px solid #e7e9ed",
            background: "rgba(255, 255, 255, 0.94)",
            backdropFilter: "blur(16px)",
          }}
        >
          <Link to="/" style={{ color: "#2867e8", fontSize: 13, fontWeight: 700 }}>
            ← タイムラインへ戻る
          </Link>
          <h1 style={{ margin: "14px 0 3px", fontSize: 22 }}>ブックマーク</h1>
          <p aria-live="polite" style={{ margin: 0, color: "#69717d", fontSize: 13 }}>
            @{user.handle}
            {!bookmarksError && ` · ${posts.length}件`}
          </p>
        </header>

        <div>
          {bookmarksError ? (
            <div className="form-error" role="alert" style={{ margin: 18 }}>
              ブックマークを読み込めませんでした。時間をおいて再読み込みしてください。
            </div>
          ) : posts.length === 0 ? (
            <div className="empty-state" style={{ minHeight: 320 }}>
              <Bookmark size={30} />
              <strong>ブックマークはまだありません</strong>
              <span>投稿のブックマークボタンを押すと、ここであとから確認できます。</span>
              <Link to="/" style={{ marginTop: 8, color: "#2867e8", fontWeight: 700 }}>
                投稿を見に行く
              </Link>
            </div>
          ) : (
            posts.map((post) => <BookmarkCard key={post.id} post={post} />)
          )}
        </div>
      </section>
    </main>
  );
}
