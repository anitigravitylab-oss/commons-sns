import { Heart, MessageCircle, Repeat2 } from "lucide-react";
import { sliceCodePoints } from "./text";

export function normalizeDate(value: string) {
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  return hasTimezone ? value : `${value.replace(" ", "T")}Z`;
}

// SSR (Workers, UTC) とクライアントで同じラベルを描画するため、表示タイムゾーンを固定する。
const DISPLAY_TIME_ZONE = "Asia/Tokyo";
const sameYearFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: DISPLAY_TIME_ZONE,
  month: "long",
  day: "numeric",
});
const otherYearFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "long",
  day: "numeric",
});
const yearFormat = new Intl.DateTimeFormat("en-US", { timeZone: DISPLAY_TIME_ZONE, year: "numeric" });

export function timeAgo(value: string) {
  const parsed = new Date(normalizeDate(value)).getTime();
  if (Number.isNaN(parsed)) return "";
  const now = Date.now();
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (seconds < 60) return "今";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}時間`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}日`;
  const date = new Date(parsed);
  const format = yearFormat.format(date) === yearFormat.format(new Date(now)) ? sameYearFormat : otherYearFormat;
  return format.format(date);
}

export function avatarClass(handle: string) {
  const classes = ["avatar-blue", "avatar-violet", "avatar-orange", "avatar-green"];
  const code = handle.charCodeAt(0);
  return classes[(Number.isNaN(code) ? 0 : code) % classes.length];
}

export function isOfficialHandle(handle: string) {
  return handle === "commons_dev";
}

/**
 * Decorative initial-letter avatar. The adjacent text carries the user's
 * name everywhere this is rendered, so it is hidden from assistive tech.
 */
export function UserAvatar({ name, handle, className }: { name: string; handle: string; className?: string }) {
  return (
    <div className={`avatar ${avatarClass(handle)}${className ? ` ${className}` : ""}`} aria-hidden="true">
      {sliceCodePoints(name, 1)}
    </div>
  );
}

export function PostIdentity({ name, handle, createdAt }: { name: string; handle: string; createdAt: string }) {
  return (
    <div className="post-identity">
      <strong>{name}</strong>
      {isOfficialHandle(handle) && (
        <span className="verified" title="公式">
          <span aria-hidden="true">✓</span>
          <span className="sr-only">公式</span>
        </span>
      )}
      <span>@{handle}</span>
      <span>·</span>
      <time dateTime={normalizeDate(createdAt)} suppressHydrationWarning>
        {timeAgo(createdAt)}
      </time>
    </div>
  );
}

function ReactionCount({ label, count, icon }: { label: string; count: number; icon: React.ReactNode }) {
  return (
    <span>
      <span className="sr-only">{label}</span>
      {icon}
      <span>{count}</span>
      <span className="sr-only">件</span>
    </span>
  );
}

export function PostReactionCounts({ replies, reposts, likes }: { replies: number; reposts: number; likes: number }) {
  return (
    <div className="reaction-counts">
      <ReactionCount label="返信" count={replies} icon={<MessageCircle size={16} aria-hidden={true} />} />
      <ReactionCount label="リポスト" count={reposts} icon={<Repeat2 size={16} aria-hidden={true} />} />
      <ReactionCount label="いいね" count={likes} icon={<Heart size={16} aria-hidden={true} />} />
    </div>
  );
}

/** Structural subset of a timeline post that read-only cards need. */
export type PostSummary = {
  id: string;
  name: string;
  handle: string;
  body: string;
  createdAt: string;
  replies: number;
  reposts: number;
  likes: number;
};

/**
 * Read-only post card shared by the profile and bookmarks pages.
 *
 * @param action - Optional control rendered at the top right (e.g. a remove button).
 * @param children - Optional extra content below the reaction counts (e.g. an error).
 */
export function PostSummaryCard({
  post,
  action,
  children,
}: {
  post: PostSummary;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <article className="post-summary">
      <UserAvatar name={post.name} handle={post.handle} />
      <div className="post-summary-main">
        <header>
          <PostIdentity name={post.name} handle={post.handle} createdAt={post.createdAt} />
          {action}
        </header>
        <p>{post.body}</p>
        <PostReactionCounts replies={post.replies} reposts={post.reposts} likes={post.likes} />
        {children}
      </div>
    </article>
  );
}
