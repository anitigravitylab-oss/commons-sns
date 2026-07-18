import { createContext } from "react-router";

export type AppEnv = Env & {
  DB: D1Database;
  /** ローカル開発時のタイムライン自動更新間隔（ミリ秒）。`.dev.vars` で設定（dev 限定・暫定）。 */
  COMMONS_LOCAL_AUTO_RELOAD_MS?: string;
};

export type CloudflareContextValue = {
  env: AppEnv;
  ctx: ExecutionContext;
};

export const cloudflareContext = createContext<CloudflareContextValue>();
