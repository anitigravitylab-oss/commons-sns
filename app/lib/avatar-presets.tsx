import type { ReactNode } from "react";
import { PRESET_AVATAR_IDS, presetAvatarIdFromKey, type PresetAvatarId } from "./avatar-constraints";

export type PresetAvatar = {
  id: PresetAvatarId;
  /** 選択肢の読み上げやツールチップに使う短い名前。 */
  label: string;
  background: string;
  foreground: string;
  /** 24×24 viewBox・fill 描画の抽象シンボル。 */
  symbol: ReactNode;
};

/**
 * プリセットアバターの見た目の定義。ID・キー形式は avatar-constraints.ts が持ち、
 * サーバー側の検証はこのファイル（JSXを含む）へ依存しない。
 */
const PRESET_AVATAR_DEFS: Record<PresetAvatarId, Omit<PresetAvatar, "id">> = {
  clover: {
    label: "よつば",
    background: "#d3e6d3",
    foreground: "#4f8558",
    symbol: (
      <>
        <circle cx="8.5" cy="8.5" r="4.8" />
        <circle cx="15.5" cy="8.5" r="4.8" />
        <circle cx="8.5" cy="15.5" r="4.8" />
        <circle cx="15.5" cy="15.5" r="4.8" />
      </>
    ),
  },
  bloom: {
    label: "はな",
    background: "#f6dbe7",
    foreground: "#c9548a",
    symbol: (
      <>
        <circle cx="12" cy="5.7" r="3.2" />
        <circle cx="17.5" cy="8.9" r="3.2" />
        <circle cx="17.5" cy="15.1" r="3.2" />
        <circle cx="12" cy="18.3" r="3.2" />
        <circle cx="6.5" cy="15.1" r="3.2" />
        <circle cx="6.5" cy="8.9" r="3.2" />
        <circle cx="12" cy="12" r="3.4" />
      </>
    ),
  },
  plus: {
    label: "プラス",
    background: "#ded9f4",
    foreground: "#bc5891",
    symbol: <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3z" />,
  },
  spark: {
    label: "きらめき",
    background: "#fbe7c3",
    foreground: "#b9741d",
    symbol: <path d="M12 2c.9 5.4 4.6 9.1 10 10-5.4.9-9.1 4.6-10 10-.9-5.4-4.6-9.1-10-10 5.4-.9 9.1-4.6 10-10z" />,
  },
  snow: {
    label: "ゆき",
    background: "#5b87e0",
    foreground: "#eaf2fe",
    symbol: (
      <>
        <rect x="10.7" y="2.5" width="2.6" height="19" rx="1.3" />
        <rect x="10.7" y="2.5" width="2.6" height="19" rx="1.3" transform="rotate(60 12 12)" />
        <rect x="10.7" y="2.5" width="2.6" height="19" rx="1.3" transform="rotate(120 12 12)" />
        <circle cx="12" cy="12" r="2.6" />
      </>
    ),
  },
  drop: {
    label: "しずく",
    background: "#d2ebe5",
    foreground: "#349086",
    symbol: <path d="M12 2.6c4.4 4.9 6.9 8.3 6.9 11.6a6.9 6.9 0 1 1-13.8 0c0-3.3 2.5-6.7 6.9-11.6z" />,
  },
  sun: {
    label: "たいよう",
    background: "#fcd9c0",
    foreground: "#cc5c20",
    symbol: (
      <>
        <rect x="11" y="2" width="2" height="20" rx="1" />
        <rect x="11" y="2" width="2" height="20" rx="1" transform="rotate(45 12 12)" />
        <rect x="11" y="2" width="2" height="20" rx="1" transform="rotate(90 12 12)" />
        <rect x="11" y="2" width="2" height="20" rx="1" transform="rotate(135 12 12)" />
        <circle cx="12" cy="12" r="5" />
      </>
    ),
  },
  moon: {
    label: "つき",
    background: "#333a54",
    foreground: "#f2e7c4",
    symbol: <path d="M20.5 14.6A9.3 9.3 0 1 1 9.4 3.5a7.3 7.3 0 0 0 11.1 11.1z" />,
  },
  ring: {
    label: "リング",
    background: "#d5e7f5",
    foreground: "#4b7fc0",
    symbol: (
      <path
        fillRule="evenodd"
        d="M12 2.8a9.2 9.2 0 1 1 0 18.4 9.2 9.2 0 0 1 0-18.4zm0 5.4a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z"
      />
    ),
  },
  diamond: {
    label: "ダイヤ",
    background: "#e9def6",
    foreground: "#8a5ec6",
    symbol: <rect x="6.6" y="6.6" width="10.8" height="10.8" rx="2.4" transform="rotate(45 12 12)" />,
  },
  castle: {
    label: "おしろ",
    background: "#f4ecd7",
    foreground: "#d46084",
    symbol: <path d="M4 21V6h3.5v3.2h2.7V6h3.6v3.2h2.7V6H20v15H4z" />,
  },
  heart: {
    label: "ハート",
    background: "#f7d7d3",
    foreground: "#d74d4d",
    symbol: (
      <path d="M12 20.7C7.2 17.3 3.4 14 3.4 9.9a4.9 4.9 0 0 1 8.6-3.2 4.9 4.9 0 0 1 8.6 3.2c0 4.1-3.8 7.4-8.6 10.8z" />
    ),
  },
};

export const PRESET_AVATARS: readonly PresetAvatar[] = PRESET_AVATAR_IDS.map((id) => ({
  id,
  ...PRESET_AVATAR_DEFS[id],
}));

const PRESET_AVATARS_BY_ID = new Map(PRESET_AVATARS.map((preset) => [preset.id, preset]));

/** avatar_key に対応するプリセットを返す。プリセット以外のキーは null。 */
export function findPresetAvatar(avatarKey: string | null | undefined): PresetAvatar | null {
  const id = presetAvatarIdFromKey(avatarKey);
  return id ? (PRESET_AVATARS_BY_ID.get(id) ?? null) : null;
}

/** プリセットのシンボルだけを描く。色は親要素の color / background に従う。 */
export function PresetAvatarSymbol({ preset }: { preset: PresetAvatar }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      {preset.symbol}
    </svg>
  );
}
