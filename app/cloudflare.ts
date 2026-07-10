import { createContext } from "react-router";

export type AppEnv = Env & {
  DB: D1Database;
};

export type CloudflareContextValue = {
  env: AppEnv;
  ctx: ExecutionContext;
};

export const cloudflareContext = createContext<CloudflareContextValue>();
