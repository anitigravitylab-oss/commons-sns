import { expect, test } from "@playwright/test";
import { clickExpecting, createPost, gotoApp, logOut, postCard, signUp, uniqueHandle } from "./helpers";

test.describe("プロフィール", () => {
  test("タイムラインの投稿者名からプロフィールへ移動できる", async ({ page }) => {
    const user = await signUp(page);
    const marker = `導線確認用 ${uniqueHandle()}`;
    await createPost(page, marker);
    await logOut(page);

    // ゲストでも投稿者名のリンクからプロフィールへ飛べる。
    await postCard(page, marker).locator(".post-identity-link").click();
    await expect(page).toHaveURL(new RegExp(`/users/${user.handle}$`));
    await expect(page.getByRole("heading", { name: user.displayName, level: 1 })).toBeVisible();

    // 「タイムラインへ戻る」でタイムラインへ帰れる。
    await page.getByRole("link", { name: "タイムラインへ戻る" }).click();
    await expect(page.locator("form.composer, .account-switcher.logged-out").first()).toBeVisible();
  });

  test("自分のプロフィールに投稿と件数が表示される", async ({ page }) => {
    const user = await signUp(page);

    await page.getByRole("link", { name: "プロフィール" }).click();
    await expect(page).toHaveURL(new RegExp(`/users/${user.handle}$`));
    await expect(page.getByRole("heading", { name: user.displayName, level: 1 })).toBeVisible();
    await expect(page.locator(".subpage-subtitle")).toHaveText("0件の投稿");
    await expect(page.getByText("公開投稿はまだありません")).toBeVisible();
    await expect(page.getByText("からCommonsを利用")).toBeVisible();

    // 投稿するとプロフィールにも反映される。
    await page.getByRole("link", { name: "タイムラインへ戻る" }).click();
    const marker = `プロフィール確認用 ${uniqueHandle()}`;
    await createPost(page, marker);
    await page.getByRole("link", { name: "プロフィール" }).click();

    await expect(page.locator(".subpage-subtitle")).toHaveText("1件の投稿");
    await expect(page.locator("article.post-summary").filter({ hasText: marker })).toBeVisible();
  });

  test("プロフィール編集モーダルで表示名と自己紹介を更新できる", async ({ page }) => {
    const user = await signUp(page);
    await gotoApp(page, `/users/${user.handle}`);

    const dialog = page.getByRole("dialog");
    await clickExpecting(page.getByRole("button", { name: "プロフィールを編集" }), dialog);
    await expect(dialog.getByRole("heading", { name: "プロフィールを編集" })).toBeVisible();

    const newName = `改名 ${uniqueHandle().slice(-4)}`;
    await dialog.getByLabel("表示名").fill(newName);
    await dialog.getByLabel("自己紹介").fill("あたらしい自己紹介。\n二行目です。");
    // カウンターはコードポイント数を表示する。
    await expect(dialog.locator(".pe-counter").first()).toHaveText(`${[...newName].length}/30`);

    await dialog.getByRole("button", { name: "保存する" }).click();

    await expect(page.locator(".profile-saved-toast")).toContainText("プロフィールを更新しました");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { name: newName, level: 1 })).toBeVisible();
    await expect(page.locator(".profile-bio")).toContainText("あたらしい自己紹介。");
  });

  test("表示名が空のままでは保存できない", async ({ page }) => {
    const user = await signUp(page);
    await gotoApp(page, `/users/${user.handle}`);

    const dialog = page.getByRole("dialog");
    await clickExpecting(page.getByRole("button", { name: "プロフィールを編集" }), dialog);
    await dialog.getByLabel("表示名").fill("   ");
    await expect(dialog.getByRole("button", { name: "保存する" })).toBeDisabled();

    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(dialog).toBeHidden();
  });

  test("他人のプロフィールには編集ボタンが出ない", async ({ page }) => {
    await signUp(page);
    await gotoApp(page, "/users/aoi_note");

    await expect(page.getByRole("heading", { name: "あおい", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "プロフィールを編集" })).toHaveCount(0);
    // 代わりにフォローボタンが表示される。
    await expect(page.locator(".follow-control button")).toBeVisible();
  });

  test("未ログインではフォローボタンがログイン導線になる", async ({ page }) => {
    await page.goto("/users/aoi_note");
    const followLink = page.getByRole("link", { name: "フォローする" });
    await expect(followLink).toBeVisible();
    await followLink.click();
    await expect(page.getByRole("dialog", { name: "Commonsにログイン" })).toBeVisible();
  });
});
