import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";

test.describe("プラットフォーム", () => {
  test("ヘルスチェックAPIがD1接続を報告する", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      runtime: "cloudflare-workers",
      database: "connected",
    });
  });

  test("SSRレスポンスにセキュリティヘッダーが付く", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    const headers = response?.headers() ?? {};
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["content-type"]).toContain("text/html");
  });

  test("ログイン中のページはno-storeでキャッシュ禁止になる", async ({ page }) => {
    const anonymous = await page.goto("/");
    expect(anonymous?.headers()["cache-control"]).toBeUndefined();

    await signUp(page);
    const loggedIn = await page.reload();
    expect(loggedIn?.headers()["cache-control"]).toBe("no-store");
  });
});
