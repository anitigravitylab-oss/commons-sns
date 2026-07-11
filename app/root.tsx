import { isRouteErrorResponse, Link, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { Route } from "./+types/root";
import "./globals.css";

const quickLinkStyle = {
  border: "1px solid rgba(23, 32, 51, 0.14)",
  borderRadius: 999,
  padding: "9px 14px",
  background: "rgba(255, 255, 255, 0.94)",
  color: "#34405a",
  fontSize: 14,
  fontWeight: 700,
  textDecoration: "none",
  boxShadow: "0 8px 24px rgba(23, 32, 51, 0.12)",
} as const;

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
        <nav
          aria-label="クイックメニュー"
          style={{
            position: "fixed",
            right: 16,
            bottom: 77,
            zIndex: 25,
            display: "flex",
            gap: 8,
          }}
        >
          <Link to="/profile" style={quickLinkStyle}>
            プロフィール
          </Link>
          <Link to="/bookmarks" style={quickLinkStyle}>
            ブックマーク
          </Link>
          <Link to="/settings" aria-label="アカウント設定" style={quickLinkStyle}>
            設定
          </Link>
        </nav>
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
