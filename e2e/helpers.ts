import { expect, type Locator, type Page } from "@playwright/test";

export type E2EUser = {
  handle: string;
  displayName: string;
  password: string;
};

let sequence = 0;

/** Unique, always-valid handle: [a-z0-9_], 20 chars or fewer. */
export function uniqueHandle(): string {
  sequence += 1;
  const stamp = Date.now().toString(36);
  const salt = Math.random().toString(36).slice(2, 5);
  return `e2e_${stamp}${salt}${sequence.toString(36)}`.slice(0, 20);
}

export function uniqueUser(): E2EUser {
  const handle = uniqueHandle();
  return {
    handle,
    displayName: `E2E ${handle.slice(-6)}`,
    password: "e2e-password-123",
  };
}

/**
 * Clicks and retries until the expected element shows up.
 *
 * The very first interaction after a page load can race React hydration:
 * the server-rendered button is visible before its click handler exists.
 * Retrying the click until its effect is observable makes that harmless.
 */
export async function clickExpecting(trigger: Locator, expected: Locator): Promise<void> {
  await expect(async () => {
    // A previous attempt may have landed already — don't click twice.
    if (!(await expected.isVisible())) {
      await trigger.click({ timeout: 2_000 });
    }
    await expect(expected).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 20_000 });
}

/**
 * Navigates and waits for the dev server's module traffic to settle, which
 * is the closest portable signal for "hydrated and interactive".
 */
export async function gotoApp(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

/** Opens the auth modal from the logged-out right-hand join card. */
export async function openAuthModal(page: Page, mode: "login" | "signup"): Promise<Locator> {
  const joinCard = page.locator(".join-card");
  const trigger =
    mode === "signup"
      ? joinCard.getByRole("button", { name: "アカウントを作成" })
      : joinCard.getByRole("button", { name: "ログイン" });
  const dialog = page.getByRole("dialog");
  await clickExpecting(trigger, dialog);
  return dialog;
}

/** Registers a fresh account through the signup modal and waits for login. */
export async function signUp(page: Page, user: E2EUser = uniqueUser()): Promise<E2EUser> {
  await page.goto("/");
  const dialog = await openAuthModal(page, "signup");
  await dialog.getByLabel("表示名").fill(user.displayName);
  await dialog.getByLabel("ユーザーID").fill(user.handle);
  await dialog.getByLabel("パスワード").fill(user.password);
  await dialog.getByRole("button", { name: "アカウントを作成" }).click();

  await expect(page.locator(".account-switcher")).toContainText(user.displayName);
  return user;
}

/** Logs in through the login modal and waits for the session to appear. */
export async function logIn(page: Page, user: E2EUser): Promise<void> {
  await page.goto("/");
  const dialog = await openAuthModal(page, "login");
  await dialog.getByLabel("ユーザーID").fill(user.handle);
  await dialog.getByLabel("パスワード").fill(user.password);
  await dialog.getByRole("button", { name: "ログイン" }).click();

  await expect(page.locator(".account-switcher")).toContainText(user.displayName);
}

/** Logs out via the sidebar account switcher on the timeline. */
export async function logOut(page: Page): Promise<void> {
  await clickExpecting(
    page.locator(".account-switcher").getByRole("button", { name: "ログアウト" }),
    page.locator(".account-switcher.logged-out"),
  );
}

/** Posts from the timeline composer and waits for the post to show up. */
export async function createPost(page: Page, body: string): Promise<void> {
  const composer = page.locator("form.composer");
  await composer.getByPlaceholder("いまどうしてる？").fill(body);
  await composer.getByRole("button", { name: "投稿する" }).click();
  await expect(postCard(page, body)).toBeVisible();
}

/** The timeline card that contains the given text. */
export function postCard(page: Page, text: string) {
  return page.locator("article.post").filter({ hasText: text });
}
