import { expect, test } from "@playwright/test";
import { createPost, gotoApp, logIn, logOut, openAuthModal, postCard, signUp, uniqueHandle } from "./helpers";

test.describe("アカウント設定", () => {
  test("パスワードを変更すると新しいパスワードでログインできる", async ({ page }) => {
    const user = await signUp(page);
    const newPassword = "new-password-456";

    await gotoApp(page, "/settings");
    await expect(page.getByRole("heading", { name: "アカウント設定", level: 1 })).toBeVisible();

    const section = page.locator("section.settings-section").filter({ hasText: "パスワードを変更" });
    await section.getByLabel("現在のパスワード").fill(user.password);
    await section.getByLabel("新しいパスワード（8〜128文字）").fill(newPassword);
    await section.getByLabel("新しいパスワード（確認）").fill(newPassword);
    await section.getByRole("button", { name: "パスワードを変更する" }).click();

    await expect(section.getByText("パスワードを変更しました。")).toBeVisible();
    await expect(section.getByLabel("現在のパスワード")).toHaveValue("");

    // 旧パスワードは拒否され、新パスワードで入れる。
    await gotoApp(page, "/");
    await logOut(page);
    const dialog = await openAuthModal(page, "login");
    await dialog.getByLabel("ユーザーID").fill(user.handle);
    await dialog.getByLabel("パスワード").fill(user.password);
    await dialog.getByRole("button", { name: "ログイン" }).click();
    await expect(dialog.locator(".form-error")).toHaveText("IDまたはパスワードが違います。");

    await logIn(page, { ...user, password: newPassword });
  });

  test("現在のパスワードが違うと変更できない", async ({ page }) => {
    await signUp(page);
    await gotoApp(page, "/settings");

    const section = page.locator("section.settings-section").filter({ hasText: "パスワードを変更" });
    await section.getByLabel("現在のパスワード").fill("totally-wrong-pass");
    await section.getByLabel("新しいパスワード（8〜128文字）").fill("new-password-456");
    await section.getByLabel("新しいパスワード（確認）").fill("new-password-456");
    await section.getByRole("button", { name: "パスワードを変更する" }).click();

    await expect(section.getByRole("alert")).toHaveText("現在のパスワードが違います。");
  });

  test("設定画面からログアウトできる", async ({ page }) => {
    await signUp(page);
    await gotoApp(page, "/settings");

    await page.getByRole("button", { name: "ログアウト", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".account-switcher.logged-out")).toBeVisible();
  });

  test("アカウントを削除すると投稿もプロフィールも消える", async ({ page }) => {
    const user = await signUp(page);
    const marker = `削除予定の投稿 ${uniqueHandle()}`;
    await createPost(page, marker);

    await gotoApp(page, "/settings");
    const section = page.locator("section.settings-section.danger");
    await section.getByLabel("現在のパスワード").fill(user.password);
    await section.getByLabel(`確認のため「${user.handle}」と入力してください`).fill(user.handle);
    await section.getByRole("button", { name: "アカウントを完全に削除する" }).click();

    // ログアウト状態でタイムラインへ戻り、投稿は消えている。
    await expect(page.locator(".account-switcher.logged-out")).toBeVisible();
    await expect(postCard(page, marker)).toHaveCount(0);

    // プロフィールは404になり、再ログインもできない。
    const response = await page.goto(`/users/${user.handle}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "ページが見つかりません" })).toBeVisible();

    await gotoApp(page, "/");
    const dialog = await openAuthModal(page, "login");
    await dialog.getByLabel("ユーザーID").fill(user.handle);
    await dialog.getByLabel("パスワード").fill(user.password);
    await dialog.getByRole("button", { name: "ログイン" }).click();
    await expect(dialog.locator(".form-error")).toHaveText("IDまたはパスワードが違います。");
  });
});
