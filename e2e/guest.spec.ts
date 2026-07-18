import { expect, test } from "@playwright/test";
import { clickExpecting } from "./helpers";

test.describe("未ログイン閲覧", () => {
  test("タイムラインと登録導線が表示される", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle(/Commons/);
    await expect(page.getByRole("tab", { name: "おすすめ" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "フォロー中" })).toBeVisible();
    await expect(page.getByRole("button", { name: "ログインして、最初の投稿をしてみよう" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Commonsをはじめよう" })).toBeVisible();
    // シードデータの公開投稿が読める。
    await expect(page.locator("article.post").first()).toBeVisible();
  });

  test("公式アカウントのプロフィールとシード投稿が読める", async ({ page }) => {
    await page.goto("/users/commons_dev");

    await expect(page.getByRole("heading", { name: "Commons 開発チーム", level: 1 })).toBeVisible();
    await expect(page.locator(".profile-handle")).toHaveText("@commons_dev");
    await expect(page.getByText("Commonsの最初の公開開発が始まりました")).toBeVisible();
    // 公式バッジは commons_dev にだけ付く。
    await expect(page.locator(".verified").first()).toBeVisible();
  });

  test("保護されたナビはログインモーダルを開く", async ({ page }) => {
    await page.goto("/");
    const dialog = page.getByRole("dialog", { name: "Commonsにログイン" });
    // タイムライン上のリアクションボタンにも「ブックマーク」があるため、ナビ内に限定する。
    await clickExpecting(page.locator("nav.main-nav").getByRole("button", { name: "ブックマーク" }), dialog);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("ゲストのリアクションはログインを促す", async ({ page }) => {
    await page.goto("/");
    const dialog = page.getByRole("dialog", { name: "Commonsにログイン" });
    await clickExpecting(page.locator("article.post").first().getByRole("button", { name: "いいね" }), dialog);
    await expect(dialog).toBeVisible();
  });

  test("/bookmarks への直接アクセスはログインへ誘導される", async ({ page }) => {
    await page.goto("/bookmarks");
    await expect(page).toHaveURL(/\/\?auth=login/);
    await expect(page.getByRole("dialog", { name: "Commonsにログイン" })).toBeVisible();
  });

  test("/settings への直接アクセスはログインへ誘導される", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/\?auth=login/);
    await expect(page.getByRole("dialog", { name: "Commonsにログイン" })).toBeVisible();
  });

  test("存在しないプロフィールは404ページになる", async ({ page }) => {
    const response = await page.goto("/users/no_such_user_e2e");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "ページが見つかりません" })).toBeVisible();
    await expect(page.getByRole("link", { name: "タイムラインへ戻る" })).toBeVisible();
  });
});
