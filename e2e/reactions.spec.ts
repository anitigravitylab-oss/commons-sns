import { expect, test } from "@playwright/test";
import { createPost, postCard, signUp, uniqueHandle } from "./helpers";

test.describe("リアクション", () => {
  test("いいねの付け外しがカウントに反映される", async ({ page }) => {
    await signUp(page);
    const marker = `いいねされる投稿 ${uniqueHandle()}`;
    await createPost(page, marker);
    const likeButton = postCard(page, marker).getByRole("button", { name: "いいね" });

    await likeButton.click();
    await expect(likeButton).toHaveAttribute("aria-pressed", "true");
    await expect(likeButton.locator("small")).toHaveText("1");

    await likeButton.click();
    await expect(likeButton).toHaveAttribute("aria-pressed", "false");
    await expect(likeButton.locator("small")).toHaveText("");
  });

  test("リポストの付け外しができる", async ({ page }) => {
    await signUp(page);
    const marker = `リポストされる投稿 ${uniqueHandle()}`;
    await createPost(page, marker);
    const repostButton = postCard(page, marker).getByRole("button", { name: "リポスト" });

    await repostButton.click();
    await expect(repostButton).toHaveAttribute("aria-pressed", "true");
    await expect(repostButton.locator("small")).toHaveText("1");

    await repostButton.click();
    await expect(repostButton).toHaveAttribute("aria-pressed", "false");
  });

  test("ブックマークが一覧に載り、一覧から解除できる", async ({ page }) => {
    const user = await signUp(page);
    const marker = `保存する投稿 ${uniqueHandle()}`;
    await createPost(page, marker);

    const bookmarkButton = postCard(page, marker).getByRole("button", { name: "ブックマーク" });
    await bookmarkButton.click();
    await expect(bookmarkButton).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("link", { name: "ブックマーク" }).click();
    await expect(page).toHaveURL(/\/bookmarks/);
    await expect(page.getByRole("heading", { name: "ブックマーク", level: 1 })).toBeVisible();
    await expect(page.locator(".subpage-subtitle")).toContainText(`@${user.handle}`);
    await expect(page.locator(".subpage-subtitle")).toContainText("1件");

    const saved = page.locator("article.post-summary").filter({ hasText: marker });
    await expect(saved).toBeVisible();

    await saved.getByRole("button", { name: "ブックマークから削除" }).click();
    await expect(page.getByText("ブックマークはまだありません")).toBeVisible();
    await expect(page.locator(".subpage-subtitle")).toContainText("0件");

    // タイムラインへ戻るとブックマーク状態も外れている。
    await page.getByRole("link", { name: "タイムラインへ戻る" }).click();
    await expect(postCard(page, marker).getByRole("button", { name: "ブックマーク" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
