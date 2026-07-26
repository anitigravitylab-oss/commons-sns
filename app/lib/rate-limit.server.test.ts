import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clientKey,
  consumeToken,
  MAX_BUCKETS,
  rateLimitResponseInit,
  RATE_LIMITS,
  resetRateLimits,
} from "./rate-limit.server";

/** 固定の基準時刻（ミリ秒）。 */
const T0 = Date.parse("2026-06-01T12:00:00Z");

beforeEach(() => {
  resetRateLimits();
});

describe("clientKey", () => {
  it("prefers the Cloudflare client IP", () => {
    const request = new Request("http://test.local/", {
      headers: { "CF-Connecting-IP": " 203.0.113.7 ", "X-Forwarded-For": "198.51.100.1" },
    });
    expect(clientKey(request)).toBe("203.0.113.7");
  });

  it("ignores the client-controlled X-Forwarded-For header", () => {
    // Cloudflare は X-Forwarded-For を上書きしないので、主体キーに使うと
    // リクエストごとに別人を名乗るだけで上限を回避できてしまう。
    const spoofed = new Request("http://test.local/", {
      headers: { "X-Forwarded-For": " 198.51.100.1 , 203.0.113.9 " },
    });
    expect(clientKey(spoofed)).toBe("unknown");
  });

  it("treats blank headers as an unknown client", () => {
    // Headers は値の前後空白を落とすので、空白だけの指定は空文字になる。
    const blank = new Request("http://test.local/", { headers: { "CF-Connecting-IP": "  " } });
    expect(clientKey(blank)).toBe("unknown");
    expect(clientKey(new Request("http://test.local/"))).toBe("unknown");
  });
});

describe("consumeToken", () => {
  it("allows up to the capacity and rejects the next call", () => {
    const { capacity } = RATE_LIMITS.post;
    for (let index = 0; index < capacity; index += 1) {
      expect(consumeToken("post", "user_1", T0).allowed).toBe(true);
    }
    const verdict = consumeToken("post", "user_1", T0);
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keeps separate buckets per rule and per subject", () => {
    for (let index = 0; index < RATE_LIMITS.post.capacity; index += 1) consumeToken("post", "user_1", T0);
    expect(consumeToken("post", "user_1", T0).allowed).toBe(false);
    expect(consumeToken("post", "user_2", T0).allowed).toBe(true);
    expect(consumeToken("reaction", "user_1", T0).allowed).toBe(true);
  });

  it("refills over time and caps at the capacity", () => {
    const { capacity, refillPerSecond } = RATE_LIMITS.post;
    for (let index = 0; index < capacity; index += 1) consumeToken("post", "user_1", T0);
    expect(consumeToken("post", "user_1", T0).allowed).toBe(false);

    // 1トークンぶんの時間が経てば1回だけ通る。
    const oneToken = Math.ceil(1_000 / refillPerSecond);
    expect(consumeToken("post", "user_1", T0 + oneToken).allowed).toBe(true);
    expect(consumeToken("post", "user_1", T0 + oneToken).allowed).toBe(false);

    // 十分に時間が経てば満タンに戻るが、上限を超えて貯まりはしない。
    const later = T0 + 86_400_000;
    for (let index = 0; index < capacity; index += 1) {
      expect(consumeToken("post", "user_1", later).allowed).toBe(true);
    }
    expect(consumeToken("post", "user_1", later).allowed).toBe(false);
  });

  it("reports the seconds needed to earn one token back", () => {
    for (let index = 0; index < RATE_LIMITS.signup.capacity; index += 1) consumeToken("signup", "203.0.113.7", T0);
    // 3件/時 = 1件あたり 1200 秒
    expect(consumeToken("signup", "203.0.113.7", T0).retryAfterSeconds).toBe(1_200);
    // 半分ぶん補充されていれば残りの待ち時間だけを返す
    expect(consumeToken("signup", "203.0.113.7", T0 + 600_000).retryAfterSeconds).toBe(600);
  });

  it("ignores clocks that go backwards", () => {
    for (let index = 0; index < RATE_LIMITS.post.capacity; index += 1) consumeToken("post", "user_1", T0);
    expect(consumeToken("post", "user_1", T0 - 60_000).allowed).toBe(false);
  });

  it("evicts refilled buckets once the isolate holds too many", () => {
    // 満タンに戻ったバケツ（情報を持たない）を上限まで作る。
    for (let index = 0; index < MAX_BUCKETS; index += 1) consumeToken("post", `filler_${index}`, T0);
    // 十分に時間を進めれば全バケツが満タン扱いになり、新規要求時に一掃される。
    const later = T0 + 86_400_000;
    expect(consumeToken("post", "fresh_user", later).allowed).toBe(true);
    // 追い出し後も残量の計算は正しい。
    for (let index = 1; index < RATE_LIMITS.post.capacity; index += 1) {
      expect(consumeToken("post", "fresh_user", later).allowed).toBe(true);
    }
    expect(consumeToken("post", "fresh_user", later).allowed).toBe(false);
  });

  it("drops only the oldest buckets when none has refilled yet", () => {
    // どのバケツも消費直後（満タンではない）の状態を上限まで作る。
    const { capacity } = RATE_LIMITS.signup;
    for (let index = 0; index < MAX_BUCKETS; index += 1) {
      for (let attempt = 0; attempt < capacity; attempt += 1) consumeToken("signup", `filler_${index}`, T0);
    }
    expect(consumeToken("signup", "filler_0", T0).allowed).toBe(false);

    // 新しい主体の要求では最古のバケツだけが追い出される。全消去してしまうと、
    // 大量のキーを作るだけで他人のカウンタまで消せる＝上限が無効になる。
    expect(consumeToken("signup", "fresh_ip", T0).allowed).toBe(true);
    expect(consumeToken("signup", `filler_${MAX_BUCKETS - 1}`, T0).allowed).toBe(false);
  });

  it("defaults to the wall clock when no time is given", () => {
    expect(consumeToken("post", "user_now").allowed).toBe(true);
  });
});

describe("local development", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("never throttles under the dev server, so e2e can sign up repeatedly", async () => {
    vi.stubEnv("MODE", "development");
    vi.resetModules();
    const devModule = await import("./rate-limit.server");

    for (let index = 0; index < RATE_LIMITS.signup.capacity + 5; index += 1) {
      expect(devModule.consumeToken("signup", "unknown", T0)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
  });
});

describe("rateLimitResponseInit", () => {
  it("returns a 429 carrying Retry-After", () => {
    expect(rateLimitResponseInit({ allowed: false, retryAfterSeconds: 42 })).toEqual({
      status: 429,
      headers: { "Retry-After": "42" },
    });
  });
});

describe("resetRateLimits", () => {
  it("drops every bucket", () => {
    for (let index = 0; index < RATE_LIMITS.post.capacity; index += 1) consumeToken("post", "user_1", T0);
    expect(consumeToken("post", "user_1", T0).allowed).toBe(false);
    resetRateLimits();
    expect(consumeToken("post", "user_1", T0).allowed).toBe(true);
  });
});
