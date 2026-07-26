import { expect, test, type Page } from "@playwright/test";
import { createPost, gotoApp, logIn, logOut, postCard, signUp, uniqueHandle } from "./helpers";

/** サイドナビからブックマークへ（クライアント遷移）。 */
async function goToBookmarks(page: Page) {
  await page.locator("nav.main-nav").getByRole("link", { name: "ブックマーク" }).click();
  await expect(page.getByRole("heading", { name: "ブックマーク", level: 1 })).toBeVisible();
}

/** タイムライン先頭の投稿から、その投稿者のプロフィールへ（クライアント遷移）。 */
async function goToFirstProfile(page: Page) {
  await page.locator(".post .post-identity-link").first().click();
  await expect(page.getByRole("link", { name: "タイムラインへ戻る" })).toBeVisible();
}

/** サブページからタイムラインへ（クライアント遷移）。 */
async function backToTimeline(page: Page) {
  await page.getByRole("link", { name: "タイムラインへ戻る" }).click();
  await expect(page.locator("form.composer, .account-switcher.logged-out").first()).toBeVisible();
}

/** ローダーデータ取得（単一フェッチ）のリクエストだけを数える。 */
function countDataRequests(page: Page) {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith(".data")) urls.push(request.url());
  });
  return urls;
}

test.describe("クライアントキャッシュ", () => {
  test("クライアント遷移で戻ってもタイムラインの内容が保たれる", async ({ page }) => {
    await signUp(page);
    const marker = `キャッシュ確認 ${uniqueHandle()}`;
    await createPost(page, marker);

    await goToBookmarks(page);
    await backToTimeline(page);

    await expect(postCard(page, marker)).toBeVisible();
  });

  test("投稿直後に戻ると新しい投稿が必ず見える", async ({ page }) => {
    await signUp(page);
    const first = `1つ目 ${uniqueHandle()}`;
    await createPost(page, first);
    // ここでタイムラインがキャッシュに載る。
    await goToBookmarks(page);
    await backToTimeline(page);

    const second = `2つ目 ${uniqueHandle()}`;
    await createPost(page, second);

    // 投稿を検知してキャッシュが無効化されるので、鮮度ウィンドウ内でも最新が出る。
    await goToBookmarks(page);
    await backToTimeline(page);

    await expect(postCard(page, second)).toBeVisible();
    await expect(postCard(page, first)).toBeVisible();
  });

  test("未ログインの再訪は鮮度ウィンドウ内ならサーバーへ行かない", async ({ page }) => {
    // 鮮度ウィンドウの省略は未ログインの公開ページだけに効く（`canSkipRevalidation`）。
    // 1往復目でタイムラインとプロフィールの両方をキャッシュに載せる。
    await gotoApp(page, "/");
    await goToFirstProfile(page);
    const profileUrl = page.url();
    await backToTimeline(page);

    const dataRequests = countDataRequests(page);
    // 2往復目は履歴を戻る／進むで**同じ URL** を再訪する。並列実行中の他テストが
    // 投稿するとタイムライン先頭のカードが入れ替わり、リンクを押し直す方式では
    // 別のプロフィールへ飛んでキャッシュキーが変わってしまう。
    await page.goBack();
    await expect(page).toHaveURL(profileUrl);
    await expect(page.getByRole("link", { name: "タイムラインへ戻る" })).toBeVisible();
    await page.goForward();
    await expect(page.locator("form.composer, .account-switcher.logged-out").first()).toBeVisible();

    // Worker 呼び出しも D1 読み取りも発生しない。
    expect(dataRequests).toEqual([]);
  });

  test("他端末でセッションが失効すると、キャッシュ済みの会員ページを出し続けない", async ({ page, browser }) => {
    // ログイン中に再検証を省略すると、失効した端末が私的な一覧を出し続けられる。
    // ここでは「別端末でのパスワード変更が、この端末のセッションを失効させる」
    // 実際の経路で確かめる（`canSkipRevalidation` がログイン中に false を返す根拠）。
    const user = await signUp(page);
    // dev のタイムライン自動更新を切る。切らないと背景のポーリングが先に失効を検知して
    // しまい、「遷移時の再検証で気づく」という本来の経路を確かめられない。
    // 「タイムラインへ戻る」はこのクエリを保つので、以降の往復でも無効のまま。
    await gotoApp(page, "/?autoReloadMs=0");
    // ブックマークをキャッシュに載せてからタイムラインへ戻る。
    await goToBookmarks(page);
    await backToTimeline(page);

    // 別端末（別コンテキスト）で同じアカウントにログインし、パスワードを変更する。
    // changePassword は他のセッションをすべて失効させるので、この page のセッションも切れる。
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    try {
      await logIn(otherPage, user);
      await gotoApp(otherPage, "/settings");
      const section = otherPage.locator("section.settings-section").filter({ hasText: "パスワードを変更" });
      await section.getByLabel("現在のパスワード").fill(user.password);
      await section.getByLabel("新しいパスワード（8〜128文字）").fill("new-password-456");
      await section.getByLabel("新しいパスワード（確認）").fill("new-password-456");
      await section.getByRole("button", { name: "パスワードを変更する" }).click();
      await expect(section.getByText("パスワードを変更しました。")).toBeVisible();
    } finally {
      await otherContext.close();
    }

    // 元の端末でブックマークへ移動する。キャッシュがあっても再検証するので、
    // サーバーのリダイレクト（ログインが必要）が効いてログイン導線に戻される。
    const nav = page.locator("nav.main-nav");
    // 失効を先に検知していれば、この導線はリンクではなくログインを促すボタンになる。
    // どちらの状態でも「会員ページは出さない」ことを確かめたいので両方を受ける。
    await nav
      .getByRole("link", { name: "ブックマーク" })
      .or(nav.getByRole("button", { name: "ブックマーク" }))
      .first()
      .click();
    await expect(page.locator(".account-switcher.logged-out")).toBeVisible();
    await expect(page.getByRole("heading", { name: "ブックマーク", level: 1 })).toHaveCount(0);
  });

  test("ログアウトするとログイン中の状態がキャッシュから復活しない", async ({ page }) => {
    await signUp(page);
    const marker = `ログアウト確認 ${uniqueHandle()}`;
    await createPost(page, marker);

    const likeButton = postCard(page, marker).getByRole("button", { name: "いいね" });
    await likeButton.click();
    await expect(likeButton).toHaveAttribute("aria-pressed", "true");

    // ログイン中のタイムラインをキャッシュに載せてからログアウトする。
    await goToBookmarks(page);
    await backToTimeline(page);
    await logOut(page);

    await expect(page.locator(".account-switcher.logged-out")).toBeVisible();
    await expect(postCard(page, marker).locator("button.liked")).toHaveCount(0);

    // クライアント遷移で戻ってもログイン中の状態は復活しない。
    await postCard(page, marker).locator(".post-identity-link").click();
    await expect(page.getByRole("link", { name: "タイムラインへ戻る" })).toBeVisible();
    await backToTimeline(page);

    await expect(page.locator(".account-switcher.logged-out")).toBeVisible();
    await expect(postCard(page, marker).locator("button.liked")).toHaveCount(0);
  });
});
