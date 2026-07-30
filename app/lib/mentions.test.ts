import { describe, expect, it } from "vitest";
import { extractMentions, MENTION_MAX, splitBodySegments } from "./mentions";

describe("extractMentions", () => {
  it("行頭・行中・改行直後のメンションを拾う", () => {
    expect(extractMentions("@demo_aoi おはよう")).toEqual(["demo_aoi"]);
    expect(extractMentions("おはよう @demo_aoi さん")).toEqual(["demo_aoi"]);
    expect(extractMentions("一行目\n@demo_yuu 二行目")).toEqual(["demo_yuu"]);
    expect(extractMentions("（@demo_yuu）")).toEqual(["demo_yuu"]);
  });

  it("メールアドレスと URL の一部は拾わない", () => {
    expect(extractMentions("mail@example.com へどうぞ")).toEqual([]);
    expect(extractMentions("https://example.com/@demo_aoi を見て")).toEqual([]);
    expect(extractMentions("a@demo_aoi")).toEqual([]);
    expect(extractMentions("@@demo_aoi")).toEqual([]);
  });

  it("URL のクエリやフラグメントの中も拾わない", () => {
    // 直前の1文字だけを見ると `=` や `#` が区切りに見えてしまう。
    expect(extractMentions("https://example.com?q=@demo_aoi")).toEqual([]);
    expect(extractMentions("https://example.com/page#@demo_aoi")).toEqual([]);
    expect(extractMentions("https://example.com/x?a=1&b=@demo_aoi です")).toEqual([]);
    expect(extractMentions("www.example.com/?u=@demo_aoi")).toEqual([]);
    // URL のあとに続く本文中のメンションは、これまでどおり拾う。
    expect(extractMentions("https://example.com?q=@demo_aoi と @demo_yuu さん")).toEqual(["demo_yuu"]);
  });

  it("ローカル部が日本語のメールアドレスも拾わない", () => {
    // 直前が英数字でないので、後ろに続くドメインで見分ける。
    expect(extractMentions("太郎@example.com へどうぞ")).toEqual([]);
    expect(extractMentions("連絡先は 山田@example.co.jp です")).toEqual([]);
    // 文末の句点やピリオドはドメインではないので、メンションのまま。
    expect(extractMentions("よろしく @demo_aoi。")).toEqual(["demo_aoi"]);
    expect(extractMentions("よろしく @demo_aoi. 以上")).toEqual(["demo_aoi"]);
  });

  it("ハンドルの形（3〜20文字の英数字と _）に合わないものは拾わない", () => {
    expect(extractMentions("@ab は短すぎる")).toEqual([]);
    expect(extractMentions(`@${"a".repeat(21)} は長すぎる`)).toEqual([]);
    expect(extractMentions("@日本語 は対象外")).toEqual([]);
    // 21文字目が続くハンドルは「20文字で切って拾う」のではなく丸ごと無視する。
    expect(extractMentions(`@${"a".repeat(25)}`)).toEqual([]);
  });

  it("小文字化して重複を除き、上限件数で打ち切る", () => {
    expect(extractMentions("@Demo_Aoi と @demo_aoi は同じ")).toEqual(["demo_aoi"]);
    const many = ["aaa", "bbb", "ccc", "ddd", "eee", "fff", "ggg"].map((handle) => `@${handle}`).join(" ");
    expect(extractMentions(many)).toHaveLength(MENTION_MAX);
    expect(extractMentions(many)).toEqual(["aaa", "bbb", "ccc", "ddd", "eee"]);
  });

  it("メンションが無い本文では空配列を返す", () => {
    expect(extractMentions("ふつうの投稿です。")).toEqual([]);
    expect(extractMentions("")).toEqual([]);
  });
});

describe("splitBodySegments", () => {
  it("メンションとテキストへ分割する", () => {
    expect(splitBodySegments("やあ @demo_aoi さん")).toEqual([
      { type: "text", value: "やあ " },
      { type: "mention", handle: "demo_aoi", text: "demo_aoi" },
      { type: "text", value: " さん" },
    ]);
  });

  it("行頭のメンションでは空のテキスト断片を作らない", () => {
    expect(splitBodySegments("@demo_aoi さん")).toEqual([
      { type: "mention", handle: "demo_aoi", text: "demo_aoi" },
      { type: "text", value: " さん" },
    ]);
  });

  it("表示用の表記は本文のまま残し、handle だけを正規化する", () => {
    // 大文字混じりで書かれたメンションを小文字に置き換えて表示すると、
    // 投稿者が書いた本文と表示が食い違う。
    expect(splitBodySegments("@Demo_Aoi さん")).toEqual([
      { type: "mention", handle: "demo_aoi", text: "Demo_Aoi" },
      { type: "text", value: " さん" },
    ]);
  });

  it("末尾のメンションで終わる本文を扱える", () => {
    expect(splitBodySegments("よろしく @demo_yuu")).toEqual([
      { type: "text", value: "よろしく " },
      { type: "mention", handle: "demo_yuu", text: "demo_yuu" },
    ]);
  });

  it("上限件数を超えても表示は本文どおりに分割する（重複も残す）", () => {
    const body = "@aaa @bbb @ccc @ddd @eee @fff @aaa";
    const mentions = splitBodySegments(body).filter((segment) => segment.type === "mention");
    expect(mentions).toHaveLength(7);
  });

  it("URL やメールアドレスの中は本文のまま残す", () => {
    expect(splitBodySegments("見て https://example.com?q=@demo_aoi")).toEqual([
      { type: "text", value: "見て https://example.com?q=@demo_aoi" },
    ]);
    expect(splitBodySegments("太郎@example.com まで")).toEqual([{ type: "text", value: "太郎@example.com まで" }]);
    // URL の直後に本物のメンションが続く場合は、そこだけリンクにする。
    expect(splitBodySegments("https://example.com?q=@demo_aoi と @demo_yuu")).toEqual([
      { type: "text", value: "https://example.com?q=@demo_aoi と " },
      { type: "mention", handle: "demo_yuu", text: "demo_yuu" },
    ]);
  });

  it("メンションが無ければ本文全体が1つのテキスト断片になる", () => {
    expect(splitBodySegments("ふつうの投稿")).toEqual([{ type: "text", value: "ふつうの投稿" }]);
    expect(splitBodySegments("")).toEqual([]);
  });
});
