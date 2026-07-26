import { describe, expect, it } from "vitest";
import { constantTimeEquals } from "./constant-time";

describe("constantTimeEquals", () => {
  it("accepts identical strings, including empty ones", () => {
    expect(constantTimeEquals("", "")).toBe(true);
    expect(constantTimeEquals("invite-code", "invite-code")).toBe(true);
    expect(constantTimeEquals("日本語のコード", "日本語のコード")).toBe(true);
  });

  it("rejects strings that differ anywhere", () => {
    expect(constantTimeEquals("invite-code", "invite-codE")).toBe(false);
    expect(constantTimeEquals("Ainvite", "ainvite")).toBe(false);
  });

  it("rejects different lengths without comparing further", () => {
    expect(constantTimeEquals("short", "shorter")).toBe(false);
    expect(constantTimeEquals("", "x")).toBe(false);
  });
});
