import { useEffect, useRef } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useFetchers,
  useNavigation,
} from "react-router";
import type { Route } from "./+types/root";
import { isMutationStart, noteMutation } from "./lib/client-cache";
import "./globals.css";

export const links: Route.LinksFunction = () => [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }];

/**
 * 送信（POST）を検知して、それ以前に保存されたクライアントキャッシュを無効化する。
 *
 * 投稿・いいね・フォロー・ログイン・ログアウトの直後に古い一覧が出るのを防ぐ。
 *
 * 検知は2系統ある。
 *
 * 1. **DOM の `submit` をキャプチャ段で拾う**（主系）。送信の瞬間に同期で記録するので、
 *    React のレンダリング粒度に一切依存しない。
 * 2. `useFetchers()` / `useNavigation()` の状態遷移（副系）。`fetcher.submit()` のように
 *    DOM の submit を経由しない送信を拾う。
 *
 * 2 だけでは不十分であることを実測で確認している: 送信の開始と完了が1つのコミットに
 * まとめられると、この effect は `pending === true` を一度も観測できず、記録が丸ごと
 * 落ちる（＝送信直後の再検証が古いキャッシュを読み、投稿がタイムラインに出ない）。
 * 描画量が増えるほど起こりやすくなるため、1 を主系にしている。
 */
function CacheMutationWatcher() {
  const fetchers = useFetchers();
  const navigation = useNavigation();
  const pending =
    fetchers.some((fetcher) => fetcher.formMethod !== undefined && fetcher.formMethod !== "GET") ||
    (navigation.formMethod !== undefined && navigation.formMethod !== "GET");
  const wasPending = useRef(false);

  useEffect(() => {
    const onSubmit = (event: Event) => {
      const form = event.target;
      // GET のフォーム（検索など）はデータを変えないので無視する。
      if (form instanceof HTMLFormElement && form.method.toLowerCase() !== "get") noteMutation();
    };
    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, []);

  useEffect(() => {
    // 記録するのは「送信の立ち上がり（idle → pending）」だけ。初回マウントでも、
    // 送信が完了して idle へ戻るときでも記録しない（理由は `isMutationStart`）。
    const previousPending = wasPending.current;
    wasPending.current = pending;
    if (isMutationStart(previousPending, pending)) noteMutation();
  }, [pending]);

  return null;
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <CacheMutationWatcher />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message = status === 404 ? "ページが見つかりません" : "問題が発生しました";

  return (
    <main className="route-error">
      <span>{status}</span>
      <h1>{message}</h1>
      <a href="/">タイムラインへ戻る</a>
    </main>
  );
}
