import { expect, test, type Browser, type Page } from "@playwright/test";
import { gotoApp, signUp, type E2EUser } from "./helpers";

/** プロフィールのフォロー数（`フォロー中` / `フォロワー`）のリンク。 */
function followStat(page: Page, label: "フォロー中" | "フォロワー") {
  return page.locator(".profile-follow-stats a").filter({ hasText: label });
}

/** 一覧のうち、そのハンドルの行。 */
function followEntry(page: Page, handle: string) {
  return page.locator("article.follow-entry").filter({ has: page.locator(`a[href="/users/${handle}"]`) });
}

/**
 * 一覧の行のフォローボタンを目的の状態にして、リロード後も維持されることを確かめる。
 * 最初のクリックがハイドレーション前だと空振りするので、収束するまで繰り返す。
 */
async function ensureEntryFollowState(page: Page, url: string, handle: string, following: boolean) {
  const label = following ? "フォロー中" : "フォローする";
  await expect(async () => {
    await gotoApp(page, url);
    const button = followEntry(page, handle).locator(".follow-control button");
    if ((await button.innerText()) !== label) {
      await button.click();
      await expect(button).toHaveText(label, { timeout: 3_000 });
    }
    await page.reload();
    await expect(followEntry(page, handle).locator(".follow-control button")).toHaveText(label, { timeout: 3_000 });
  }).toPass({ timeout: 45_000 });
}

/**
 * 別のブラウザ文脈でアカウントを作り、指定ハンドルをフォローしておく。
 *
 * シードユーザーを使わずテストが自前でフォロワーを用意することで、
 * 並列に走る他のスペックとフォロワー数を取り合わない。
 */
async function createFollowerOf(browser: Browser, handle: string): Promise<E2EUser> {
  const context = await browser.newContext();
  const other = await context.newPage();
  try {
    const user = await signUp(other);
    await expect(async () => {
      await gotoApp(other, `/users/${handle}`);
      const button = other.locator(".follow-control button");
      if ((await button.innerText()) !== "フォロー中") {
        await button.click();
        await expect(button).toHaveText("フォロー中", { timeout: 3_000 });
      }
      await other.reload();
      await expect(other.locator(".follow-control button")).toHaveText("フォロー中", { timeout: 3_000 });
    }).toPass({ timeout: 45_000 });
    return user;
  } finally {
    await context.close();
  }
}

test.describe("フォロー一覧", () => {
  test("プロフィールの数字から一覧へ入り、その場でフォローできる", async ({ page, browser }) => {
    const viewer = await signUp(page);
    const follower = await createFollowerOf(browser, viewer.handle);

    // 自分のプロフィールのフォロワー数のリンクから一覧へ入る。
    await gotoApp(page, `/users/${viewer.handle}`);
    await followStat(page, "フォロワー").click();
    await expect(page).toHaveURL(new RegExp(`/users/${viewer.handle}/followers$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`@${viewer.handle} のフォロワー`);
    const followerRow = followEntry(page, follower.handle);
    await expect(followerRow).toBeVisible();
    // 自分のフォロワー一覧に並ぶ相手は、定義上こちらをフォローしている。
    await expect(followerRow.locator(".follow-entry-badge")).toHaveText("フォローされています");
    // 自分はまだ誰もフォローしていないので、行のボタンは「フォローする」で始まる。
    await expect(followerRow.locator(".follow-control button")).toHaveText("フォローする");

    // タブでフォロー中一覧へ切り替えられる（まだ誰もフォローしていない）。
    await page.getByRole("tab", { name: "フォロー中" }).click();
    await expect(page).toHaveURL(new RegExp(`/users/${viewer.handle}/following$`));
    await expect(page.getByText("まだ誰もフォローしていません")).toBeVisible();

    // 一覧の行からフォローバックする。
    await ensureEntryFollowState(page, `/users/${viewer.handle}/followers`, follower.handle, true);

    // 自分のプロフィールのフォロー数が追随し、そこから自分のフォロー中一覧へ入れる。
    await gotoApp(page, `/users/${viewer.handle}`);
    await expect(followStat(page, "フォロー中").locator("strong")).toHaveText("1");
    await followStat(page, "フォロー中").click();
    await expect(page).toHaveURL(new RegExp(`/users/${viewer.handle}/following$`));
    await expect(followEntry(page, follower.handle)).toBeVisible();

    // 解除も一覧の行からでき、数字も戻る。
    // 解除は自分のフォロワー一覧で行う。自分のフォロー中一覧は「解除した相手が
    // 次の読み込みで一覧から消える」のが正しい挙動なので、ボタンの状態を読む場所にできない
    // （フォロワー一覧の顔ぶれは、こちらのフォロー状態では変わらない）。
    await ensureEntryFollowState(page, `/users/${viewer.handle}/followers`, follower.handle, false);
    await gotoApp(page, `/users/${viewer.handle}`);
    await expect(followStat(page, "フォロー中").locator("strong")).toHaveText("0");
    // 解除した相手は自分のフォロー中一覧から消える。
    await gotoApp(page, `/users/${viewer.handle}/following`);
    await expect(page.getByText("まだ誰もフォローしていません")).toBeVisible();
  });

  test("未ログインでも一覧は読めるが、フォローボタンは出ない", async ({ page, browser }) => {
    // 一覧の主とフォロワーの両方を、別のブラウザ文脈で用意する（メインの page は未ログインのまま）。
    const context = await browser.newContext();
    const ownerPage = await context.newPage();
    const owner = await signUp(ownerPage);
    await context.close();
    const follower = await createFollowerOf(browser, owner.handle);

    await gotoApp(page, `/users/${owner.handle}/followers`);
    await expect(followEntry(page, follower.handle)).toBeVisible();
    await expect(page.locator("article.follow-entry .follow-control")).toHaveCount(0);
  });

  test("存在しないハンドルの一覧は404になる", async ({ page }) => {
    const response = await page.goto("/users/no_such_user_at_all/followers");
    expect(response?.status()).toBe(404);
  });
});
