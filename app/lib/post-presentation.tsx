export function normalizeDate(value: string) {
  return value.endsWith("Z") || value.includes("+") ? value : `${value.replace(" ", "T")}Z`;
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
