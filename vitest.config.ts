import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["app/**/*.test.{ts,tsx}", "workers/**/*.test.ts"],
    environment: "node",
    // Miniflare (workerd) boots once per suite in beforeAll and PBKDF2 runs
    // 100k iterations per hash, so the defaults are too tight on slow CI.
    testTimeout: 15_000,
    // `beforeAll` は Miniflare（workerd の子プロセス）を起動してマイグレーションを
    // 流すが、スイート数ぶんの workerd がコア数を超えて同時に立ち上がるため、
    // 起動だけで 30 秒に届くことがある（症状は `Hook timed out` で、そのファイルの
    // テストが丸ごと skip される）。テスト本体の遅さではないので、ここだけを広げて
    // 並列度は落とさない。
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["app/**/*.{ts,tsx}", "workers/**/*.ts"],
      exclude: [
        "app/**/*.test.{ts,tsx}",
        "app/testing/**",
        // Streaming SSR glue and route components are exercised by the
        // Playwright E2E suite, not by unit tests.
        "app/entry.server.tsx",
        "app/root.tsx",
      ],
      thresholds: {
        // The server-side modules are the contract of this app; keep them
        // effectively fully covered. The headroom below 100% on branches is
        // taken up by defensive fallbacks real D1 can never trigger
        // (e.g. `result.results ?? []`).
        "app/lib/*.server.ts": { statements: 98, branches: 88, functions: 100, lines: 98 },
        "app/lib/text.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
