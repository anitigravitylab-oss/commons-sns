import { Heart, MessageCircle, Repeat2 } from "lucide-react";

export function normalizeDate(value: string) {
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  return hasTimezone ? value : `${value.replace(" ", "T")}Z`;
}

export function timeAgo(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(normalizeDate(value)).getTime()) / 1000));
  if (seconds < 60) return "今";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}時間`;
  return `${Math.floor(seconds / 86_400)}日`;
}

export function avatarClass(handle: string) {
  const classes = ["avatar-blue", "avatar-violet", "avatar-orange", "avatar-green"];
  return classes[handle.charCodeAt(0) % classes.length];
}

export function isOfficialHandle(handle: string) {
  return handle === "commons_dev";
}

export function PostIdentity({ name, handle, createdAt }: { name: string; handle: string; createdAt: string }) {
  return (
    <div className="post-identity">
      <strong>{name}</strong>
      {isOfficialHandle(handle) && (
        <span className="verified" aria-label="公式">
          ✓
        </span>
      )}
      <span>@{handle}</span>
      <span>·</span>
      <span>{timeAgo(createdAt)}</span>
    </div>
  );
}

export function PostReactionCounts({ replies, reposts, likes }: { replies: number; reposts: number; likes: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24, color: "#69717d", fontSize: 12 }}>
      <span
        role="img"
        aria-label={`返信 ${replies}件`}
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <MessageCircle size={16} aria-hidden={true} /> <span aria-hidden={true}>{replies}</span>
      </span>
      <span
        role="img"
        aria-label={`リポスト ${reposts}件`}
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <Repeat2 size={16} aria-hidden={true} /> <span aria-hidden={true}>{reposts}</span>
      </span>
      <span
        role="img"
        aria-label={`いいね ${likes}件`}
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <Heart size={16} aria-hidden={true} /> <span aria-hidden={true}>{likes}</span>
      </span>
    </div>
  );
}
