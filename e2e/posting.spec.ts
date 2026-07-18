import { expect, test } from "@playwright/test";
import { createPost, postCard, signUp, uniqueHandle } from "./helpers";

test.describe("投稿", () => {
  test("投稿するとタイムラインに現れ、コンポーザーが空になる", async ({ page }) => {
    await signUp(page);
    const marker = `はじめての投稿 ${uniqueHandle()}`;

    await createPost(page, marker);

    await expect(page.getByPlaceholder("いまどうしてる？")).toHaveValue("");
    await expect(postCard(page, marker)).toBeVisible();
  });

  test("改行を含む投稿がそのまま表示される", async ({ page }) => {
    await signUp(page);
    const marker = uniqueHandle();

    const composer = page.locator("form.composer");
    await composer.getByPlaceholder("いまどうしてる？").fill(`一行目 ${marker}\n二行目もあります`);
    await composer.getByRole("button", { name: "投稿する" }).click();

    const card = postCard(page, `一行目 ${marker}`);
    await expect(card).toBeVisible();
    await expect(card.locator("p")).toContainText("二行目もあります");
  });

  test("文字数カウンターが残数を警告し、超過時は投稿できない", async ({ page }) => {
    await signUp(page);
    const textarea = page.getByPlaceholder("いまどうしてる？");
    const submit = page.locator("form.composer").getByRole("button", { name: "投稿する" });

    await textarea.fill("あ".repeat(275));
    await expect(page.locator(".limit.near")).toHaveText("5");
    await expect(submit).toBeEnabled();

    await textarea.fill("あ".repeat(281));
    await expect(page.locator(".limit.over")).toHaveText("-1");
    await expect(submit).toBeDisabled();

    // 絵文字はコードポイント単位で数える(サロゲートペアでも280文字扱い)。
    await textarea.fill("😀".repeat(280));
    await expect(page.locator(".composer-submit .limit")).toHaveText("0");
    await expect(submit).toBeEnabled();
  });

  test("自分の投稿を削除できる", async ({ page }) => {
    await signUp(page);
    const marker = `消える投稿 ${uniqueHandle()}`;
    await createPost(page, marker);

    await postCard(page, marker).getByRole("button", { name: "投稿を削除" }).click();
    await expect(postCard(page, marker)).toHaveCount(0);
  });

  test("検索は読み込み済みタイムラインを絞り込む", async ({ page }) => {
    await signUp(page);
    const markerA = `りんごの話 ${uniqueHandle()}`;
    const markerB = `みかんの話 ${uniqueHandle()}`;
    await createPost(page, markerA);
    await createPost(page, markerB);

    const search = page.getByPlaceholder("タイムライン内を検索");
    await search.fill(markerA);
    await expect(postCard(page, markerA)).toBeVisible();
    await expect(postCard(page, markerB)).toHaveCount(0);

    await page.getByRole("button", { name: "検索を消す" }).click();
    await expect(postCard(page, markerA)).toBeVisible();
    await expect(postCard(page, markerB)).toBeVisible();

    await search.fill("該当なしのはずのクエリ zzz999");
    await expect(page.getByText("投稿が見つかりません")).toBeVisible();
  });
});
