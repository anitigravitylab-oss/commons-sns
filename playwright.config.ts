import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against the real dev server (Cloudflare Vite plugin +
 * workerd + local D1). Run `npm run db:migrate:local` once before the first
 * run so the local database has the schema and seed data.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 4,
  // The dev server compiles on demand, so first paints can be slow.
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
