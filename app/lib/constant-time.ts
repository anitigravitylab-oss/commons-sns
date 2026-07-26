/**
 * 文字列の定数時間比較。
 *
 * 長さが違う場合は即 false を返す（長さは秘密でない前提）。パスワードハッシュの
 * 照合と招待コードの検証で共有する。
 */
export function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}
