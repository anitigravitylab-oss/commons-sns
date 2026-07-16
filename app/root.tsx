import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { Route } from "./+types/root";
import "./globals.css";

export const links: Route.LinksFunction = () => [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }];

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
