import { describe, expect, it } from "vitest";
import { countCodePoints, isReservedHandle, RESERVED_HANDLES, sanitizeText, sliceCodePoints } from "./text";

describe("countCodePoints", () => {
  it("counts ASCII strings by character", () => {
    expect(countCodePoints("")).toBe(0);
    expect(countCodePoints("hello")).toBe(5);
  });

  it("counts astral characters as a single code point", () => {
    // "😀" is one code point but two UTF-16 units — .length would say 2.
    expect(countCodePoints("😀")).toBe(1);
    expect(countCodePoints("a😀b")).toBe(3);
  });

  it("counts each code point of a ZWJ emoji sequence", () => {
    // 家族の絵文字は「男性+ZWJ+女性+ZWJ+女児」の5コードポイント。
    expect(countCodePoints("👨‍👩‍👧")).toBe(5);
  });

  it("counts combining marks separately", () => {
    expect(countCodePoints("が")).toBe(2);
  });

  it("stops counting just past the limit", () => {
    expect(countCodePoints("aaaaaaaa", 3)).toBe(4);
    expect(countCodePoints("abc", 3)).toBe(3);
    expect(countCodePoints("ab", 3)).toBe(2);
  });
});

describe("sliceCodePoints", () => {
  it("returns an empty string for a non-positive max", () => {
    expect(sliceCodePoints("hello", 0)).toBe("");
    expect(sliceCodePoints("hello", -1)).toBe("");
  });

  it("truncates on code point boundaries without splitting surrogate pairs", () => {
    expect(sliceCodePoints("😀😁😂", 1)).toBe("😀");
    expect(sliceCodePoints("😀😁😂", 2)).toBe("😀😁");
  });

  it("returns the value unchanged when it fits", () => {
    expect(sliceCodePoints("あいう", 3)).toBe("あいう");
    expect(sliceCodePoints("あいう", 10)).toBe("あいう");
    expect(sliceCodePoints("", 5)).toBe("");
  });
});

describe("sanitizeText", () => {
  it("strips newlines and tabs in single-line mode", () => {
    expect(sanitizeText("a\nb\tc")).toBe("abc");
  });

  it("keeps newlines and tabs in multiline mode but strips carriage returns", () => {
    expect(sanitizeText("line1\r\nline2\tend", { multiline: true })).toBe("line1\nline2\tend");
  });

  it("strips C0/C1 control characters", () => {
    expect(sanitizeText("a\u0000b\u0008c\u001fd\u007fe\u009ff")).toBe("abcdef");
    expect(sanitizeText("a\u000bb\u000cc", { multiline: true })).toBe("abc");
  });

  it("strips invisible and bidi-control characters in both modes", () => {
    const invisible = "a\u200bb\u200ec\u200fd\u2060e\ufefff\u202ag\u202eh\u2066i\u2069j";
    expect(sanitizeText(invisible)).toBe("abcdefghij");
    expect(sanitizeText(invisible, { multiline: true })).toBe("abcdefghij");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeText("  こんにちは  ")).toBe("こんにちは");
    expect(sanitizeText("\n\n本文\n\n", { multiline: true })).toBe("本文");
  });

  it("keeps ordinary Japanese text and emoji intact", () => {
    expect(sanitizeText("こんにちは、世界🌏")).toBe("こんにちは、世界🌏");
  });

  it("returns an empty string when only invisible characters remain", () => {
    expect(sanitizeText("\u200b\u2060\ufeff")).toBe("");
  });
});

describe("isReservedHandle", () => {
  it("reserves operational and brand handles", () => {
    expect(isReservedHandle("admin")).toBe(true);
    expect(isReservedHandle("commons_dev")).toBe(true);
    expect(isReservedHandle("settings")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isReservedHandle("Admin")).toBe(true);
    expect(isReservedHandle("MODERATOR")).toBe(true);
  });

  it("allows ordinary handles", () => {
    expect(isReservedHandle("aoi_note")).toBe(false);
    expect(isReservedHandle("admin2")).toBe(false);
  });

  it("keeps every reserved entry lowercased so the lookup can normalize", () => {
    for (const handle of RESERVED_HANDLES) {
      expect(handle).toBe(handle.toLowerCase());
    }
  });
});
