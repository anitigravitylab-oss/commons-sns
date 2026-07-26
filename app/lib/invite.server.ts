import type { AppEnv } from "../cloudflare";
import { constantTimeEquals } from "./constant-time";

/**
 * 招待コードが必要かどうか。
 *
 * `INVITE_CODE` が未設定・空文字なら従来どおり誰でも登録できる。
 * 公開インスタンスを限定公開で運用したいときにシークレットとして設定する
 * （`wrangler secret put INVITE_CODE`。`wrangler.jsonc` には書かない）。
 */
export function isInviteRequired(env: AppEnv): boolean {
  return (env.INVITE_CODE ?? "").trim().length > 0;
}

/**
 * 提示された招待コードを検証する。未設定時は常に true。
 * コードは秘密情報なので比較は定数時間で行う。
 */
export function verifyInviteCode(env: AppEnv, provided: string): boolean {
  const expected = (env.INVITE_CODE ?? "").trim();
  if (expected.length === 0) return true;
  return constantTimeEquals(provided.trim(), expected);
}

/**
 * 初期管理者のブートストラップ用コードが設定されているか。
 *
 * **ハンドル名では認可しない。** 「特定のハンドルで登録した人を admin にする」方式は、
 * その設定値が非シークレット（設定ファイルに入り、`admin` のように推測もできる）なので、
 * 運営者より先に第三者が名乗るだけでインスタンスを乗っ取れてしまう。
 * 権限の根拠は、シークレットとして配布されたコードの知識に置く
 * （`wrangler secret put ADMIN_BOOTSTRAP_CODE`。`wrangler.jsonc` には書かない）。
 */
export function isAdminBootstrapConfigured(env: AppEnv): boolean {
  return (env.ADMIN_BOOTSTRAP_CODE ?? "").trim().length > 0;
}

/**
 * 提示されたブートストラップコードを検証する。
 *
 * 未設定時は常に false（＝昇格しない）。招待コードと違い「未設定なら素通し」には
 * しない。設定されていないインスタンスで誰でも admin になれてしまうため。
 */
export function verifyAdminBootstrapCode(env: AppEnv, provided: string): boolean {
  const expected = (env.ADMIN_BOOTSTRAP_CODE ?? "").trim();
  if (expected.length === 0) return false;
  return constantTimeEquals(provided.trim(), expected);
}
