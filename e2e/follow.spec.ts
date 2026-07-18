import { expect, test, type Page } from "@playwright/test";
import { createPost, gotoApp, postCard, signUp, uniqueHandle } from "./helpers";

const AOI_SEED_POST = "新しいSNSなのに、最初から操作を覚え直さなくていい";

/**
 * Drives the follow toggle to the desired state and confirms it server-side
 * with a reload. Retrying end-to-end makes a double-fired toggle (native
 * submit racing the fetcher during hydration) converge instead of flaking.
 */
async function ensureFollowState(page: Page, handle: string, following: boolean) {
  const label = following ? "フォロー中" : "フォローする";
  await expect(async () => {
    await gotoApp(page, `/users/${handle}`);
    const button = page.locator(".follow-control button");
    if ((await button.innerText()) !== label) {
      await button.click();
      await expect(button).toHaveText(label, { timeout: 3_000 });
    }
    await page.reload();
    await expect(page.locator(".follow-control button")).toHaveText(label, { timeout: 3_000 });
  }).toPass({ timeout: 45_000 });
}

test.describe("フォロー", () => {
  test("フォローとフォロー中タイムライン、解除までの一連の流れ", async ({ page }) => {
    await signUp(page);
    const marker = `自分の投稿 ${uniqueHandle()}`;
    await createPost(page, marker);

    // シードユーザー aoi_note のフォロワー数を基準として控えておく。
    await gotoApp(page, "/users/aoi_note");
    const followerCount = page
      .locator(".profile-follow-stats > span")
      .filter({ hasText: "フォロワー" })
      .locator("strong");
    const before = Number(await followerCount.innerText());

    // フォローすると、リロード後も維持されフォロワー数が増える。
    await ensureFollowState(page, "aoi_note", true);
    await expect(followerCount).toHaveText(String(before + 1));

    // フォロー中タブには自分とフォロー相手の投稿だけが出る。
    await page.goto("/?tab=following");
    await expect(page.getByRole("tab", { name: "フォロー中" })).toHaveAttribute("aria-selected", "true");
    await expect(postCard(page, marker)).toBeVisible();
    await expect(postCard(page, AOI_SEED_POST)).toBeVisible();

    // 解除すると相手の投稿はフォロー中タブから消える。
    await ensureFollowState(page, "aoi_note", false);
    await expect(followerCount).toHaveText(String(before));

    await page.goto("/?tab=following");
    await expect(postCard(page, marker)).toBeVisible();
    await expect(postCard(page, AOI_SEED_POST)).toHaveCount(0);
  });
});
