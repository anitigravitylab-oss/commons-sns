import { data, Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/settings";
import { cloudflareContext } from "../cloudflare";
import { clearSessionCookie, findUserForLogin, getSessionUser, verifyPasswordOrDummy } from "../lib/auth.server";

type ActionResult = { error?: string };

export function meta() {
  return [{ title: "アカウント設定 — Commons" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await getSessionUser(request, env);
  if (!user) return redirect("/");
  return { user };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await getSessionUser(request, env);
  if (!user) return redirect("/");

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  if (intent !== "deleteAccount") return data<ActionResult>({ error: "不明な操作です。" }, { status: 400 });

  const password = String(formData.get("password") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");

  if (confirmation !== user.handle.toLowerCase()) {
    return data<ActionResult>({ error: "確認用のユーザーIDが一致しません。" }, { status: 400 });
  }

  const account = await findUserForLogin(env, user.handle);
  if (!(await verifyPasswordOrDummy(password, account?.password_hash, account?.password_salt))) {
    return data<ActionResult>({ error: "パスワードが違います。" }, { status: 401 });
  }

  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM post_reactions WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM post_reactions WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)").bind(
        user.id,
      ),
      env.DB.prepare("DELETE FROM follows WHERE follower_id = ? OR following_id = ?").bind(user.id, user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM media WHERE owner_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM posts WHERE author_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
    ]);
  } catch (error) {
    console.error("Failed to delete account", error);
    return data<ActionResult>(
      {
        error: "アカウントを削除できませんでした。時間をおいてもう一度お試しください。",
      },
      { status: 500 },
    );
  }

  return redirect("/", {
    headers: { "Set-Cookie": clearSessionCookie() },
  });
}

function DeleteAccountButton() {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting" && navigation.formData?.get("intent") === "deleteAccount";

  return (
    <button
      type="submit"
      disabled={isSubmitting}
      style={{
        justifySelf: "start",
        border: 0,
        borderRadius: 999,
        padding: "12px 20px",
        background: "#c62828",
        color: "white",
        font: "inherit",
        fontWeight: 750,
        cursor: isSubmitting ? "wait" : "pointer",
        opacity: isSubmitting ? 0.7 : 1,
      }}
    >
      {isSubmitting ? "削除しています…" : "アカウントを完全に削除する"}
    </button>
  );
}

export default function SettingsPage({ loaderData, actionData }: Route.ComponentProps) {
  const { user } = loaderData;

  return (
    <main
      style={{
        maxWidth: 680,
        margin: "0 auto",
        padding: "48px 20px 80px",
        fontFamily: "system-ui, sans-serif",
        color: "#172033",
      }}
    >
      <Link to="/" style={{ color: "#2962d9", textDecoration: "none" }}>
        ← タイムラインへ戻る
      </Link>
      <h1 style={{ marginTop: 28 }}>アカウント設定</h1>
      <p style={{ color: "#657086" }}>@{user.handle}</p>

      <section
        style={{
          marginTop: 40,
          border: "1px solid #efc8c8",
          borderRadius: 16,
          padding: 24,
          background: "#fffafa",
        }}
      >
        <h2 style={{ marginTop: 0, color: "#b42318" }}>アカウントを削除</h2>
        <p style={{ lineHeight: 1.7 }}>
          アカウントを削除すると、投稿、いいね、リポスト、ブックマーク、フォロー情報などが削除されます。
          この操作は元に戻せません。
        </p>

        <Form method="post" style={{ display: "grid", gap: 18, marginTop: 24 }}>
          <input type="hidden" name="intent" value="deleteAccount" />
          <label style={{ display: "grid", gap: 8, fontWeight: 650 }}>
            現在のパスワード
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              style={{
                padding: "12px 14px",
                border: "1px solid #cbd2df",
                borderRadius: 10,
                font: "inherit",
              }}
            />
          </label>
          <label style={{ display: "grid", gap: 8, fontWeight: 650 }}>
            確認のため「{user.handle}」と入力してください
            <input
              name="confirmation"
              required
              autoCapitalize="none"
              autoComplete="off"
              style={{
                padding: "12px 14px",
                border: "1px solid #cbd2df",
                borderRadius: 10,
                font: "inherit",
              }}
            />
          </label>

          {actionData?.error && (
            <div role="alert" style={{ color: "#b42318", fontWeight: 650 }}>
              {actionData.error}
            </div>
          )}

          <DeleteAccountButton />
        </Form>
      </section>
    </main>
  );
}
