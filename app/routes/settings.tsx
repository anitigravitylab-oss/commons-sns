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
import { clientKey, consumeToken, rateLimitResponseInit, RATE_LIMIT_MESSAGE } from "../lib/rate-limit.server";
import { crossSiteRejection, readFormDataBounded } from "../lib/request-guard.server";
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

/**
 * 資格情報まわりの枠を1つ消費し、超過していれば 429 応答を返す。通過時は null。
 *
 * 呼ぶ位置は「安価な検証を通ったあと・PBKDF2 の導出より前」。検証より前に消費すると、
 * 確認欄の打ち間違いを5回しただけで枠が空になり、本人がパスワード変更も退会も
 * できなくなる（どちらも同じ枠を共有している）。守りたいのは PBKDF2 の CPU なので、
 * その手前でありさえすれば効き方は変わらない。
 *
 * 主体は「利用者 × 送信元」にする。利用者だけを主体にすると、盗まれたセッションを
 * 持つ第三者が失敗する送信を撃ち続けるだけで枠を空にでき、本人のパスワード変更
 * （＝そのセッションを失効させる唯一の手段）と退会を 429 で塞げてしまう。
 * 送信元が違えば別の枠になるので、本人の復旧は通る。
 */
function enforceCredentialLimit(request: Request, userId: string, form: "password" | "delete") {
  const verdict = consumeToken("credential", `${userId}:${clientKey(request)}`);
  if (verdict.allowed) return null;
  return data<ActionResult>({ error: RATE_LIMIT_MESSAGE, form }, rateLimitResponseInit(verdict));
}

export async function action({ request, context }: Route.ActionArgs) {
  // クロスサイト送信と過大な本文は、セッションを引く前に落とす（`request-guard.server.ts`）。
  // 順序が要点で、セッションを先に引くと、過大な本文を投げるだけで 413 の前に
  // D1 への往復を1回ぶん踏ませられる。
  const rejected = crossSiteRejection(request);
  if (rejected) return rejected;

  const { env } = context.get(cloudflareContext);
  const body = await readFormDataBounded(request);
  if (!body.ok) return data<ActionResult>({ error: body.message }, { status: body.status });
  const formData = body.formData;

  const user = await getSessionUser(request, env);
  if (!user) return redirect("/?auth=login");

  const intent = String(formData.get("intent") ?? "");

  if (intent === "logout") {
    return redirect("/", { headers: { "Set-Cookie": await destroySession(request, env) } });
  }
  if (intent === "changePassword") return handleChangePassword(env, request, formData, user.handle, user.id);
  if (intent === "deleteAccount") return handleDeleteAccount(env, request, formData, user.handle, user.id);

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

  // ここから先は PBKDF2 の導出が2回走る（現在のパスワードの照合と、新しい
  // パスワードのハッシュ化）。枠を消費するのは、その手前のこの位置。
  const limited = enforceCredentialLimit(request, userId, "password");
  if (limited) return limited;

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

async function handleDeleteAccount(env: AppEnv, request: Request, formData: FormData, handle: string, userId: string) {
  const password = String(formData.get("password") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");

  if (confirmation !== handle.toLowerCase()) {
    return data<ActionResult>({ error: "確認用のユーザーIDが一致しません。", form: "delete" }, { status: 400 });
  }

  // 以降はパスワードの照合（PBKDF2）に入る。枠の消費はその手前で行う。
  const limited = enforceCredentialLimit(request, userId, "delete");
  if (limited) return limited;

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
      {actionData?.error && !actionData.form && (
        <div role="alert" className="form-error subpage-alert">
          {actionData.error}
        </div>
      )}

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
