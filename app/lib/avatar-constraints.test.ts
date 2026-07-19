import { describe, expect, it } from "vitest";
import {
  isPresetAvatarId,
  PRESET_AVATAR_IDS,
  PRESET_AVATAR_KEY_PREFIX,
  presetAvatarIdFromKey,
  presetAvatarKey,
} from "./avatar-constraints";
import { findPresetAvatar, PRESET_AVATARS } from "./avatar-presets";

describe("preset avatar keys", () => {
  it("round-trips every preset id through its avatar_key form", () => {
    for (const id of PRESET_AVATAR_IDS) {
      const key = presetAvatarKey(id);
      expect(key).toBe(`${PRESET_AVATAR_KEY_PREFIX}${id}`);
      expect(presetAvatarIdFromKey(key)).toBe(id);
    }
  });

  it("rejects everything that is not a stored preset key", () => {
    expect(presetAvatarIdFromKey(null)).toBeNull();
    expect(presetAvatarIdFromKey(undefined)).toBeNull();
    expect(presetAvatarIdFromKey("")).toBeNull();
    // 生のID（接頭辞なし）はキーとして扱わない。
    expect(presetAvatarIdFromKey("clover")).toBeNull();
    expect(presetAvatarIdFromKey("preset:")).toBeNull();
    expect(presetAvatarIdFromKey("preset:unknown")).toBeNull();
    // 将来のアップロード画像キー（R2キーなど）はプリセットに解決されない。
    expect(presetAvatarIdFromKey("avatars/user_1/original.png")).toBeNull();
  });

  it("isPresetAvatarId matches exactly the declared ids", () => {
    for (const id of PRESET_AVATAR_IDS) expect(isPresetAvatarId(id)).toBe(true);
    expect(isPresetAvatarId("")).toBe(false);
    expect(isPresetAvatarId("preset:clover")).toBe(false);
  });
});

describe("PRESET_AVATARS", () => {
  it("defines a visual for every id, in the same order", () => {
    expect(PRESET_AVATARS.map((preset) => preset.id)).toEqual([...PRESET_AVATAR_IDS]);
  });

  it("gives every preset a distinct label and a color pair", () => {
    const labels = new Set(PRESET_AVATARS.map((preset) => preset.label));
    expect(labels.size).toBe(PRESET_AVATARS.length);
    for (const preset of PRESET_AVATARS) {
      expect(preset.background).toMatch(/^#[0-9a-f]{6}$/);
      expect(preset.foreground).toMatch(/^#[0-9a-f]{6}$/);
      expect(preset.symbol).toBeTruthy();
    }
  });

  it("findPresetAvatar resolves stored keys and rejects the rest", () => {
    expect(findPresetAvatar("preset:clover")?.id).toBe("clover");
    expect(findPresetAvatar(null)).toBeNull();
    expect(findPresetAvatar("preset:unknown")).toBeNull();
    expect(findPresetAvatar("avatars/user_1/original.png")).toBeNull();
  });
});
