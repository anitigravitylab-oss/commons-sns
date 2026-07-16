import { useEffect, useState } from "react";
import { data, Form, redirect, useFetcher, useNavigation } from "react-router";
import type { Route } from "./+types/settings";
import { cloudflareContext, type AppEnv } from "../cloudflare";
import {
  changePassword,
  clearSessionCookie,
  destroySession,
  findUserForLogin,
  getSessionUser,
  verifyPasswordOrDummy,
} from "../lib/auth.server";
import { SubpageShell } from "../lib/subpage";

type ActionResult = { ok?: boolean; error?: string; form?: "password" | "delete" };

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

export function meta() {
  return [{ title: "アカウント設定 — Commons" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await getSessionUser(request, env);
  if (!user) return redirect("/?auth=login");
  return { user };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await getSessionUser(request, env);
  if (!user) return redirect("/?auth=login");

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "logout") {
    return redirect("/", { headers: { "Set-Cookie": await destroySession(request, env) } });
  }
  if (intent === "changePassword") return handleChangePassword(env, request, formData, user.handle, user.id);
  if (intent === "deleteAccount") return handleDeleteAccount(env, formData, user.handle, user.id);

  return data<ActionResult>({ error: "不明な操作です。" }, { status: 400 });
}

async function handleChangePassword(env: AppEnv, request: Request, formData: FormData, handle: string, userId: string) {
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const newPasswordConfirm = String(formData.get("newPasswordConfirm") ?? "");

  if (newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > PASSWORD_MAX_LENGTH) {
    return data<ActionResult>(
      {
        error: `新しいパスワードは${PASSWORD_MIN_LENGTH}〜${PASSWORD_MAX_LENGTH}文字で入力してください。`,
        form: "password",
      },
      { status: 400 },
    );
  }
  if (newPassword !== newPasswordConfirm) {
    return data<ActionResult>({ error: "新しいパスワードが確認用と一致しません。", form: "password" }, { status: 400 });
  }

  const account = await findUserForLogin(env, handle);
  if (!(await verifyPasswordOrDummy(currentPassword, account?.password_hash, account?.password_salt))) {
    return data<ActionResult>({ error: "現在のパスワードが違います。", form: "password" }, { status: 401 });
  }

  try {
    await changePassword(request, env, userId, newPassword);
  } catch (error) {
    console.error("Failed to change password", error);
    return data<ActionResult>(
      { error: "パスワードを変更できませんでした。時間をおいてもう一度お試しください。", form: "password" },
      { status: 500 },
    );
  }

  return data<ActionResult>({ ok: true, form: "password" });
}

async function handleDeleteAccount(env: AppEnv, formData: FormData, handle: string, userId: string) {
  const password = String(formData.get("password") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");

  if (confirmation !== handle.toLowerCase()) {
    return data<ActionResult>({ error: "確認用のユーザーIDが一致しません。", form: "delete" }, { status: 400 });
  }

  const account = await findUserForLogin(env, handle);
  if (!(await verifyPasswordOrDummy(password, account?.password_hash, account?.password_salt))) {
    return data<ActionResult>({ error: "パスワードが違います。", form: "delete" }, { status: 401 });
  }

  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM post_reactions WHERE user_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM post_reactions WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)").bind(
        userId,
      ),
      env.DB.prepare("DELETE FROM follows WHERE follower_id = ? OR following_id = ?").bind(userId, userId),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM media WHERE owner_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM posts WHERE author_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
    ]);
  } catch (error) {
    console.error("Failed to delete account", error);
    return data<ActionResult>(
      { error: "アカウントを削除できませんでした。時間をおいてもう一度お試しください。", form: "delete" },
      { status: 500 },
    );
  }

  return redirect("/", {
    headers: { "Set-Cookie": clearSessionCookie() },
  });
}

function LogoutSection() {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting" && navigation.formData?.get("intent") === "logout";

  return (
    <section className="settings-section">
      <h2>セッション</h2>
      <p>この端末からログアウトします。ほかの端末のログイン状態はそのまま残ります。</p>
      <Form method="post" className="settings-form">
        <input type="hidden" name="intent" value="logout" />
        <button type="submit" className="settings-submit secondary" disabled={isSubmitting}>
          {isSubmitting ? "ログアウトしています…" : "ログアウト"}
        </button>
      </Form>
    </section>
  );
}

function PasswordSection() {
  const fetcher = useFetcher<ActionResult>();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const isSubmitting = fetcher.state !== "idle";
  const changed = fetcher.state === "idle" && fetcher.data?.ok === true;

  useEffect(() => {
    if (!changed) return;
    setCurrentPassword("");
    setNewPassword("");
    setNewPasswordConfirm("");
  }, [changed]);

  return (
    <section className="settings-section">
      <h2>パスワードを変更</h2>
      <p>変更すると、この端末以外のログインはすべて無効になります。</p>
      <fetcher.Form method="post" className="settings-form">
        <input type="hidden" name="intent" value="changePassword" />
        <label>
          現在のパスワード
          <input
            name="currentPassword"
            type="password"
            required
            autoComplete="current-password"
            className="settings-input"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <label>
          新しいパスワード（{PASSWORD_MIN_LENGTH}〜{PASSWORD_MAX_LENGTH}文字）
          <input
            name="newPassword"
            type="password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            autoComplete="new-password"
            className="settings-input"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </label>
        <label>
          新しいパスワード（確認）
          <input
            name="newPasswordConfirm"
            type="password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            autoComplete="new-password"
            className="settings-input"
            value={newPasswordConfirm}
            onChange={(event) => setNewPasswordConfirm(event.target.value)}
          />
        </label>

        {fetcher.data?.form === "password" && fetcher.data.error && (
          <div role="alert" className="form-error">
            {fetcher.data.error}
          </div>
        )}
        {changed && <div className="form-success">パスワードを変更しました。</div>}

        <button type="submit" className="settings-submit" disabled={isSubmitting}>
          {isSubmitting ? "変更しています…" : "パスワードを変更する"}
        </button>
      </fetcher.Form>
    </section>
  );
}

function DeleteAccountButton() {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting" && navigation.formData?.get("intent") === "deleteAccount";

  return (
    <button type="submit" className="settings-submit danger" disabled={isSubmitting}>
      {isSubmitting ? "削除しています…" : "アカウントを完全に削除する"}
    </button>
  );
}

export default function SettingsPage({ loaderData, actionData }: Route.ComponentProps) {
  const { user } = loaderData;

  return (
    <SubpageShell
      heading={
        <>
          <h1>アカウント設定</h1>
          <p className="subpage-subtitle">@{user.handle}</p>
        </>
      }
    >
      <LogoutSection />
      <PasswordSection />

      <section className="settings-section danger">
        <h2>アカウントを削除</h2>
        <p>
          アカウントを削除すると、投稿、いいね、リポスト、ブックマーク、フォロー情報などが削除されます。
          この操作は元に戻せません。
        </p>

        <Form method="post" className="settings-form">
          <input type="hidden" name="intent" value="deleteAccount" />
          <label>
            現在のパスワード
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="settings-input"
            />
          </label>
          <label>
            確認のため「{user.handle}」と入力してください
            <input name="confirmation" required autoCapitalize="none" autoComplete="off" className="settings-input" />
          </label>

          {actionData?.form === "delete" && actionData.error && (
            <div role="alert" className="form-error">
              {actionData.error}
            </div>
          )}

          <DeleteAccountButton />
        </Form>
      </section>
    </SubpageShell>
  );
}
