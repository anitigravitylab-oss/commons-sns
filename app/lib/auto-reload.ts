/**
 * ローカル開発時のタイムライン自動更新間隔の決定（dev 限定・暫定機能）。
 *
 * 本番向けの push 配信（SSE / WebSocket）を導入する際に削除する。
 * 間隔は `.dev.vars` の `COMMONS_LOCAL_AUTO_RELOAD_MS` で設定する。
 */

/** 自動更新の既定間隔（ミリ秒）。`.dev.vars` 未設定時に使う。 */
export const DEFAULT_LOCAL_AUTO_RELOAD_MS = 2000;

/** 自動更新間隔の下限（ミリ秒）。これより短かい指定は切り上げる。 */
export const MIN_LOCAL_AUTO_RELOAD_MS = 500;

/** 自動更新間隔の上限（ミリ秒）。これより長い指定は切り下げる。 */
export const MAX_LOCAL_AUTO_RELOAD_MS = 60000;

/**
 * 文字列形式の自動更新間隔を数値に正規化する。
 *
 * @param raw - 環境変数や URL クエリの生値
 * @returns `0`（無効化）・クランプ済みの整数（ms）・`null`（未設定 or 不正値）
 */
export function normalizeAutoReloadMs(raw: string | undefined | null): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n === 0) return 0;
  return Math.min(MAX_LOCAL_AUTO_RELOAD_MS, Math.max(MIN_LOCAL_AUTO_RELOAD_MS, Math.trunc(n)));
}

/**
 * dev フラグ・環境変数・URL クエリから最終的な自動更新間隔を決定する。
 *
 * 本番（isDev=false）では常に 0。dev では URL クエリ `?autoReloadMs=` を優先し、
 * 次に環境変数、最後に既定値を使う。
 *
 * @param args.isDev - `import.meta.env.DEV`
 * @param args.envValue - `env.COMMONS_LOCAL_AUTO_RELOAD_MS`（`.dev.vars`）
 * @param args.queryValue - `searchParams.get("autoReloadMs")`
 * @returns 自動更新間隔（ms）。0 のときは無効化
 */
export function resolveAutoReloadMs(args: {
  isDev: boolean;
  envValue: string | undefined;
  queryValue: string | null;
}): number {
  if (!args.isDev) return 0;
  const fromQuery = normalizeAutoReloadMs(args.queryValue);
  if (fromQuery !== null) return fromQuery;
  return normalizeAutoReloadMs(args.envValue) ?? DEFAULT_LOCAL_AUTO_RELOAD_MS;
}
