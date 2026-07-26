import { RouterContextProvider } from "react-router";
import { cloudflareContext, type AppEnv } from "../cloudflare";
import { createSession } from "../lib/auth.server";

/**
 * Minimal ExecutionContext double. `waitForBackgroundTasks` awaits everything
 * handed to `waitUntil`, letting tests observe deferred cleanup work.
 */
export function createExecutionContext() {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      tasks.push(promise);
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    async waitForBackgroundTasks() {
      await Promise.allSettled(tasks);
    },
  };
}

/** Builds the `context` argument loaders and actions receive from the worker. */
export function routerContext(env: AppEnv, ctx: ExecutionContext = createExecutionContext().ctx) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env, ctx });
  return context;
}

/**
 * Builds the full argument object of a server loader/action
 * (`{ request, url, params, pattern, context }`).
 */
export function routeArgs<Params = Record<string, never>>(
  request: Request,
  env: AppEnv,
  options: { pattern: string; params?: Params; ctx?: ExecutionContext },
) {
  return {
    request,
    url: new URL(request.url),
    params: (options.params ?? {}) as Params,
    pattern: options.pattern,
    context: routerContext(env, options.ctx),
  };
}

/**
 * POST request carrying an urlencoded form, like a submitted `<Form>`.
 *
 * `ip` sets `CF-Connecting-IP`（本番で Cloudflare が付けるヘッダ）。レートリミットの
 * 主体キーはこれだけを見るので、送信元ごとの挙動を確かめるテストで指定する。
 *
 * `Content-Length` は**明示的に付ける**。ブラウザは `<form>` 送信でも `fetch` でも
 * 必ず付けるが、`Request` のコンストラクタは付けない（fetch 仕様上ヘッダリストに
 * 入らない）ため、付けないとテストだけが本文サイズの門番に引っかかる。
 *
 * `origin` / `secFetchSite` はクロスサイト送信の門番を確かめるためのもので、
 * 省略すると「判定材料が無い送信」＝素通しになる。
 */
export function formRequest(
  url: string,
  fields: Record<string, string>,
  options: {
    cookie?: string;
    ip?: string;
    origin?: string;
    secFetchSite?: string;
    /** 実際の本文とは別の長さを申告させる（本文サイズの門番のテスト用）。 */
    contentLength?: number;
  } = {},
): Request {
  const body = new URLSearchParams(fields).toString();
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" });
  headers.set("Content-Length", String(options.contentLength ?? new TextEncoder().encode(body).byteLength));
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.ip) headers.set("CF-Connecting-IP", options.ip);
  if (options.origin) headers.set("Origin", options.origin);
  if (options.secFetchSite) headers.set("Sec-Fetch-Site", options.secFetchSite);
  return new Request(url, { method: "POST", body, headers });
}

/** POST request whose body cannot be parsed as form data. */
export function malformedFormRequest(url: string, options: { cookie?: string } = {}): Request {
  const body = "{}";
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set("Content-Length", String(body.length));
  if (options.cookie) headers.set("Cookie", options.cookie);
  return new Request(url, { method: "POST", body, headers });
}

export function getRequest(url: string, options: { cookie?: string } = {}): Request {
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  return new Request(url, { headers });
}

/** Creates a real session for the user and returns a `Cookie` header value. */
export async function loginCookie(env: AppEnv, userId: string): Promise<string> {
  const setCookie = await createSession(env, userId);
  return setCookie.split(";")[0];
}

type DataWithResponseInit<T> = { type: "DataWithResponseInit"; data: T; init: ResponseInit | null };

function isDataResult<T>(value: unknown): value is DataWithResponseInit<T> {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "DataWithResponseInit";
}

/** Unwraps a react-router `data()` result into its payload and status. */
export function expectData<T>(result: unknown): { data: T; status: number } {
  if (result instanceof Response) {
    throw new Error(`expected a data() result but got a Response (status ${result.status})`);
  }
  if (isDataResult<T>(result)) {
    return { data: result.data, status: result.init?.status ?? 200 };
  }
  // Loaders may also return plain objects, which are implicitly 200s.
  return { data: result as T, status: 200 };
}

/** Asserts the result is a redirect Response and returns its target and cookie. */
export function expectRedirect(result: unknown): { location: string; setCookie: string | null; status: number } {
  if (!(result instanceof Response)) {
    throw new Error(`expected a redirect Response but got ${JSON.stringify(result)}`);
  }
  if (result.status < 300 || result.status >= 400) {
    throw new Error(`expected a redirect status but got ${result.status}`);
  }
  return {
    location: result.headers.get("Location") ?? "",
    setCookie: result.headers.get("Set-Cookie"),
    status: result.status,
  };
}
