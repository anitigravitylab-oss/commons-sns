import { describe, expect, it } from "vitest";
import type { AppEnv } from "../cloudflare";
import {
  isAdminBootstrapConfigured,
  isInviteRequired,
  verifyAdminBootstrapCode,
  verifyInviteCode,
} from "./invite.server";

/** 招待コードだけを持つ最小の env。DB は触らないので省略できる。 */
function envWith(inviteCode?: string): AppEnv {
  return { INVITE_CODE: inviteCode } as unknown as AppEnv;
}

/** ブートストラップコードだけを持つ最小の env。 */
function bootstrapEnv(code?: string): AppEnv {
  return { ADMIN_BOOTSTRAP_CODE: code } as unknown as AppEnv;
}

describe("isInviteRequired", () => {
  it("is off when the secret is unset, empty or blank", () => {
    expect(isInviteRequired(envWith())).toBe(false);
    expect(isInviteRequired(envWith(""))).toBe(false);
    expect(isInviteRequired(envWith("   "))).toBe(false);
  });

  it("is on when the secret holds a value", () => {
    expect(isInviteRequired(envWith("open-sesame"))).toBe(true);
  });
});

describe("verifyInviteCode", () => {
  it("accepts anything while the instance is open", () => {
    expect(verifyInviteCode(envWith(), "")).toBe(true);
    expect(verifyInviteCode(envWith("  "), "whatever")).toBe(true);
  });

  it("accepts the exact code and tolerates surrounding whitespace", () => {
    const env = envWith("open-sesame");
    expect(verifyInviteCode(env, "open-sesame")).toBe(true);
    expect(verifyInviteCode(env, "  open-sesame \n")).toBe(true);
  });

  it("rejects a wrong code, a differently-cased code and an empty input", () => {
    const env = envWith("open-sesame");
    expect(verifyInviteCode(env, "open-sesam")).toBe(false);
    expect(verifyInviteCode(env, "Open-Sesame")).toBe(false);
    expect(verifyInviteCode(env, "")).toBe(false);
  });

  it("compares against the trimmed secret", () => {
    expect(verifyInviteCode(envWith("  padded  "), "padded")).toBe(true);
  });
});

describe("isAdminBootstrapConfigured", () => {
  it("未設定・空文字・空白のみなら無効", () => {
    expect(isAdminBootstrapConfigured(bootstrapEnv())).toBe(false);
    expect(isAdminBootstrapConfigured(bootstrapEnv(""))).toBe(false);
    expect(isAdminBootstrapConfigured(bootstrapEnv("   "))).toBe(false);
  });

  it("値があれば有効", () => {
    expect(isAdminBootstrapConfigured(bootstrapEnv("launch-code"))).toBe(true);
  });
});

describe("verifyAdminBootstrapCode", () => {
  it("未設定のインスタンスでは常に false（招待コードと違い素通ししない）", () => {
    // ここを true にすると、コードを設定していないインスタンスで誰でも admin になれる。
    expect(verifyAdminBootstrapCode(bootstrapEnv(), "")).toBe(false);
    expect(verifyAdminBootstrapCode(bootstrapEnv(), "anything")).toBe(false);
    expect(verifyAdminBootstrapCode(bootstrapEnv("  "), "anything")).toBe(false);
  });

  it("完全一致だけを受け入れる（前後の空白は無視）", () => {
    const env = bootstrapEnv("launch-code");
    expect(verifyAdminBootstrapCode(env, "launch-code")).toBe(true);
    expect(verifyAdminBootstrapCode(env, "  launch-code \n")).toBe(true);
    expect(verifyAdminBootstrapCode(env, "Launch-Code")).toBe(false);
    expect(verifyAdminBootstrapCode(env, "launch-cod")).toBe(false);
    expect(verifyAdminBootstrapCode(env, "")).toBe(false);
  });
});
