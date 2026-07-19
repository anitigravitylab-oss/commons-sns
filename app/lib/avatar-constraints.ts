/**
 * プリセットアバターの識別子と、users.avatar_key 上での表現。
 *
 * プリセット選択は `preset:<id>` 形式で avatar_key に保存する。将来の
 * 画像アップロードは別形式のキー（R2キーなど）をそのまま使う想定で、
 * この接頭辞がプリセットの名前空間になる。スキーマ変更は不要。
 */
export const PRESET_AVATAR_KEY_PREFIX = "preset:";

export const PRESET_AVATAR_IDS = [
  "clover",
  "bloom",
  "plus",
  "spark",
  "snow",
  "drop",
  "sun",
  "moon",
  "ring",
  "diamond",
  "castle",
  "heart",
] as const;

export type PresetAvatarId = (typeof PRESET_AVATAR_IDS)[number];

export function isPresetAvatarId(value: string): value is PresetAvatarId {
  return (PRESET_AVATAR_IDS as readonly string[]).includes(value);
}

/** プリセットIDを avatar_key に保存する形へ変換する（`clover` → `preset:clover`）。 */
export function presetAvatarKey(id: PresetAvatarId): string {
  return `${PRESET_AVATAR_KEY_PREFIX}${id}`;
}

/**
 * avatar_key からプリセットIDを取り出す。
 *
 * @returns プリセット以外（null、将来の画像キー、未知のID）は null。
 */
export function presetAvatarIdFromKey(avatarKey: string | null | undefined): PresetAvatarId | null {
  if (!avatarKey || !avatarKey.startsWith(PRESET_AVATAR_KEY_PREFIX)) return null;
  const id = avatarKey.slice(PRESET_AVATAR_KEY_PREFIX.length);
  return isPresetAvatarId(id) ? id : null;
}
