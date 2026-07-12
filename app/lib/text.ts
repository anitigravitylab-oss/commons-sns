export function countCodePoints(value: string, limit: number = Number.POSITIVE_INFINITY): number {
  let count = 0;
  const iterator = value[Symbol.iterator]();
  while (!iterator.next().done) {
    count += 1;
    if (count > limit) break;
  }
  return count;
}

export function sliceCodePoints(value: string, max: number): string {
  if (max <= 0) return "";

  const points: string[] = [];
  let count = 0;
  for (const point of value) {
    points.push(point);
    count += 1;
    if (count === max) return points.join("");
  }
  return value;
}

const codePoint = (code: number) => String.fromCharCode(code);
const codeRange = (from: number, to: number) => `${codePoint(from)}-${codePoint(to)}`;

const INVISIBLE_CLASS =
  codeRange(0x007f, 0x009f) +
  codePoint(0x200b) +
  codeRange(0x200e, 0x200f) +
  codePoint(0x2060) +
  codePoint(0xfeff) +
  codeRange(0x202a, 0x202e) +
  codeRange(0x2066, 0x2069);

const SINGLE_LINE_PATTERN = new RegExp(`[${codeRange(0x0000, 0x001f)}${INVISIBLE_CLASS}]`, "gu");
const MULTILINE_PATTERN = new RegExp(
  `[${codeRange(0x0000, 0x0008)}${codeRange(0x000b, 0x001f)}${INVISIBLE_CLASS}]`,
  "gu",
);

export function sanitizeText(value: string, options: { multiline?: boolean } = {}): string {
  const pattern = options.multiline ? MULTILINE_PATTERN : SINGLE_LINE_PATTERN;
  return value.replace(pattern, "").trim();
}

export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "root",
  "system",
  "sysadmin",
  "mod",
  "moderator",
  "owner",
  "staff",
  "official",
  "support",
  "help",
  "info",
  "contact",
  "security",
  "abuse",
  "everyone",
  "all",
  "api",
  "settings",
  "login",
  "signin",
  "signup",
  "logout",
  "register",
  "bookmarks",
  "profile",
  "users",
  "commons",
  "commons_dev",
  "commons_official",
  "commonsteam",
  "commons_team",
  "commons_support",
]);

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.toLowerCase());
}
