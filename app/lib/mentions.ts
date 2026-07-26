/**
 * 本文中の `@handle` の抽出と分割。
 *
 * クライアント（表示）と、将来のサーバー側利用（通知の宛先解決など）で同じ規則を
 * 使えるよう、D1 にも DOM にも触れない純粋関数だけを置く。
 *
 * ハンドルの実在確認はしない（表示は 0 クエリ）。存在しないハンドルは
 * リンク先のプロフィールが 404 になるだけで、タイムライン1画面あたり最大 50 件の
 * ハンドル照合を D1 へ投げるより圧倒的に安い。
 */

/** 本文から抽出するメンションの上限。 */
export const MENTION_MAX = 5;

/**
 * メンションの抽出パターン。
 *
 * 直前が英数字・`_`・`@`・`/` のときはメンションとみなさない
 * （`mail@example.com` や `https://example.com/@user` の誤検出を防ぐ）。
 * ハンドルの形は登録時の検証と同じ `[a-z0-9_]{3,20}`。
 */
const MENTION_PATTERN = /(^|[^0-9A-Za-z_@/])@([a-z0-9_]{3,20})(?![0-9a-z_])/gi;

/**
 * 本文から `@handle` を抽出する。
 *
 * @returns 小文字化して重複を除いたハンドル。先頭 {@link MENTION_MAX} 件まで。
 */
export function extractMentions(body: string): string[] {
  const handles: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const handle = match[2].toLowerCase();
    if (seen.has(handle)) continue;
    seen.add(handle);
    handles.push(handle);
    if (handles.length >= MENTION_MAX) break;
  }
  return handles;
}

/** 本文をメンション部分とそれ以外に分割した結果。 */
export type BodySegment =
  | { type: "text"; value: string }
  | {
      type: "mention";
      /** 正規化（小文字化）済みのハンドル。リンク先 URL や照合に使う。 */
      handle: string;
      /** 本文に書かれたままの表記（`@` は含まない）。表示に使う。 */
      text: string;
    };

/**
 * 本文をメンション部分とそれ以外に分割する（表示用）。
 *
 * `extractMentions` と違い、件数の上限も重複の除去も行わない
 * （本文の見た目は本文どおりでなければならない）。表示用の `text` には
 * 大文字小文字を含め入力どおりの表記を残し、正規化は `handle` 側だけで行う。
 */
export function splitBodySegments(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(MENTION_PATTERN)) {
    // match[1] は「直前の1文字」なので、@ の位置は match.index + match[1].length。
    const start = (match.index ?? 0) + match[1].length;
    if (start > cursor) segments.push({ type: "text", value: body.slice(cursor, start) });
    segments.push({ type: "mention", handle: match[2].toLowerCase(), text: match[2] });
    cursor = start + match[2].length + 1;
  }
  if (cursor < body.length) segments.push({ type: "text", value: body.slice(cursor) });
  return segments;
}
