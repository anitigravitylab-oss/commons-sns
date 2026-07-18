import { expect, test } from "@playwright/test";
import { logIn, logOut, openAuthModal, signUp, uniqueUser } from "./helpers";

test.describe("アカウント登録とログイン", () => {
  test("登録 → ログアウト → 再ログインが一巡できる", async ({ page }) => {
    const user = await signUp(page);

    // ログイン状態: コンポーザーとアカウント表示が出る。
    await expect(page.getByPlaceholder("いまどうしてる？")).toBeVisible();
    await expect(page.locator(".account-switcher")).toContainText(`@${user.handle}`);

    await logOut(page);
    await expect(page.getByRole("button", { name: "ログインして、最初の投稿をしてみよう" })).toBeVisible();

    await logIn(page, user);
    await expect(page.locator(".account-switcher")).toContainText(user.displayName);
  });

  test("予約済みIDでは登録できない", async ({ page }) => {
    await page.goto("/");
    const dialog = await openAuthModal(page, "signup");

    await dialog.getByLabel("表示名").fill("なりすまし");
    await dialog.getByLabel("ユーザーID").fill("admin");
    await dialog.getByLabel("パスワード").fill("password-123");
    await dialog.getByRole("button", { name: "アカウントを作成" }).click();

    await expect(dialog.locator(".form-error")).toHaveText("このIDは使用できません。");
    // モーダルは登録フォームのまま維持される。
    await expect(dialog.getByRole("heading", { name: "Commonsをはじめる" })).toBeVisible();
  });

  test("使用中のIDでは登録できない", async ({ page }) => {
    const user = await signUp(page);
    await logOut(page);

    const dialog = await openAuthModal(page, "signup");
    await dialog.getByLabel("表示名").fill("二人目");
    await dialog.getByLabel("ユーザーID").fill(user.handle);
    await dialog.getByLabel("パスワード").fill("password-456");
    await dialog.getByRole("button", { name: "アカウントを作成" }).click();

    await expect(dialog.locator(".form-error")).toHaveText("そのIDはすでに使われています。");
  });

  test("誤ったパスワードではログインできない", async ({ page }) => {
    const user = await signUp(page);
    await logOut(page);

    const dialog = await openAuthModal(page, "login");
    await dialog.getByLabel("ユーザーID").fill(user.handle);
    await dialog.getByLabel("パスワード").fill("wrong-password-1");
    await dialog.getByRole("button", { name: "ログイン" }).click();

    await expect(dialog.locator(".form-error")).toHaveText("IDまたはパスワードが違います。");
    await expect(page.locator(".account-switcher.logged-out")).toBeVisible();
  });

  test("モーダルはログインと登録を行き来でき、Escapeで閉じる", async ({ page }) => {
    await page.goto("/");
    const dialog = await openAuthModal(page, "login");
    await expect(dialog.getByRole("heading", { name: "Commonsにログイン" })).toBeVisible();

    await dialog.getByRole("button", { name: "はじめての方はこちら" }).click();
    await expect(dialog.getByRole("heading", { name: "Commonsをはじめる" })).toBeVisible();

    await dialog.getByRole("button", { name: "すでにアカウントをお持ちの方" }).click();
    await expect(dialog.getByRole("heading", { name: "Commonsにログイン" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("登録直後は同じIDの大文字小文字違いでもログインできる", async ({ page }) => {
    const base = uniqueUser();
    await signUp(page, base);
    await logOut(page);

    const dialog = await openAuthModal(page, "login");
    await dialog.getByLabel("ユーザーID").fill(`@${base.handle.toUpperCase()}`);
    await dialog.getByLabel("パスワード").fill(base.password);
    await dialog.getByRole("button", { name: "ログイン" }).click();

    await expect(page.locator(".account-switcher")).toContainText(base.displayName);
  });
});
