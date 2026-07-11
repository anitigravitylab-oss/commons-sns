import { Heart, MessageCircle, Repeat2 } from "lucide-react";

const SCREEN_READER_ONLY_STYLE = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
} as const;

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

function ReactionCount({ label, count, icon }: { label: string; count: number; icon: React.ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={SCREEN_READER_ONLY_STYLE}>{label}</span>
      {icon}
      <span>{count}</span>
      <span style={SCREEN_READER_ONLY_STYLE}>件</span>
    </span>
  );
}

export function PostReactionCounts({ replies, reposts, likes }: { replies: number; reposts: number; likes: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24, color: "#69717d", fontSize: 12 }}>
      <ReactionCount label="返信" count={replies} icon={<MessageCircle size={16} aria-hidden={true} />} />
      <ReactionCount label="リポスト" count={reposts} icon={<Repeat2 size={16} aria-hidden={true} />} />
      <ReactionCount label="いいね" count={likes} icon={<Heart size={16} aria-hidden={true} />} />
    </div>
  );
}
