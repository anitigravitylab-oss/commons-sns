import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  avatarClass,
  isOfficialHandle,
  normalizeDate,
  PostIdentity,
  PostReactionCounts,
  PostSummaryCard,
  timeAgo,
  UserAvatar,
} from "./post-presentation";

describe("normalizeDate", () => {
  it("marks naive D1 timestamps as UTC", () => {
    expect(normalizeDate("2026-07-01 12:34:56")).toBe("2026-07-01T12:34:56Z");
  });

  it("leaves values with an explicit timezone untouched", () => {
    expect(normalizeDate("2026-07-01T12:34:56Z")).toBe("2026-07-01T12:34:56Z");
    expect(normalizeDate("2026-07-01T12:34:56+09:00")).toBe("2026-07-01T12:34:56+09:00");
    expect(normalizeDate("2026-07-01T12:34:56-0500")).toBe("2026-07-01T12:34:56-0500");
  });
});

describe("timeAgo", () => {
  // 2026-07-15 21:00 JST (12:00 UTC) — a fixed "now" keeps every bucket stable.
  const NOW = new Date("2026-07-15T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an empty string for unparsable dates", () => {
    expect(timeAgo("not a date")).toBe("");
  });

  it("labels anything under a minute (and clock skew into the future) as 今", () => {
    expect(timeAgo("2026-07-15 11:59:30")).toBe("今");
    expect(timeAgo("2026-07-15 11:59:01")).toBe("今");
    expect(timeAgo("2026-07-15 12:00:30")).toBe("今");
  });

  it("labels minutes, hours and days", () => {
    expect(timeAgo("2026-07-15 11:59:00")).toBe("1分");
    expect(timeAgo("2026-07-15 11:01:00")).toBe("59分");
    expect(timeAgo("2026-07-15 11:00:00")).toBe("1時間");
    expect(timeAgo("2026-07-14 13:00:00")).toBe("23時間");
    expect(timeAgo("2026-07-14 12:00:00")).toBe("1日");
    expect(timeAgo("2026-07-09 12:00:00")).toBe("6日");
  });

  it("labels dates a week or older with a JST calendar date", () => {
    expect(timeAgo("2026-07-08 12:00:00")).toBe("7月8日");
    expect(timeAgo("2026-02-01 00:00:00")).toBe("2月1日");
  });

  it("includes the year for dates outside the current JST year", () => {
    expect(timeAgo("2025-11-03 00:00:00")).toBe("2025年11月3日");
  });

  it("uses the JST calendar year when UTC and JST disagree", () => {
    // 2025-12-31 20:00 UTC is already 2026-01-01 05:00 in Tokyo.
    expect(timeAgo("2025-12-31 20:00:00")).toBe("1月1日");
    // 2025-12-31 10:00 UTC is still 2025 in Tokyo.
    expect(timeAgo("2025-12-31 10:00:00")).toBe("2025年12月31日");
  });
});

describe("avatarClass", () => {
  it("assigns a stable palette class from the handle's first character", () => {
    expect(avatarClass("d_handle")).toBe("avatar-blue"); // "d" = 100 → 100 % 4 = 0
    expect(avatarClass("a_handle")).toBe("avatar-violet"); // "a" = 97 → 1
    expect(avatarClass("b_handle")).toBe("avatar-orange"); // "b" = 98 → 2
    expect(avatarClass("c_handle")).toBe("avatar-green"); // "c" = 99 → 3
  });

  it("falls back to the first class for an empty handle", () => {
    expect(avatarClass("")).toBe("avatar-blue");
  });
});

describe("isOfficialHandle", () => {
  it("only recognizes the commons_dev account", () => {
    expect(isOfficialHandle("commons_dev")).toBe(true);
    expect(isOfficialHandle("commons_dev2")).toBe(false);
    expect(isOfficialHandle("COMMONS_DEV")).toBe(false);
  });
});

describe("UserAvatar", () => {
  it("renders the first code point of the name, hidden from assistive tech", () => {
    const html = renderToStaticMarkup(<UserAvatar name="😀あおい" handle="aoi_note" />);
    expect(html).toContain(">😀<");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("avatar-violet");
  });

  it("appends an optional class name", () => {
    const html = renderToStaticMarkup(<UserAvatar name="あ" handle="aoi_note" className="small" />);
    expect(html).toContain('class="avatar avatar-violet small"');
  });
});

describe("PostIdentity", () => {
  it("shows the name, handle and a machine-readable timestamp", () => {
    const html = renderToStaticMarkup(<PostIdentity name="あおい" handle="aoi_note" createdAt="2026-07-01 00:00:00" />);
    expect(html).toContain("あおい");
    expect(html).toContain("@aoi_note");
    expect(html).toContain('dateTime="2026-07-01T00:00:00Z"');
    expect(html).not.toContain("公式");
  });

  it("adds the verified badge only for the official account", () => {
    const html = renderToStaticMarkup(
      <PostIdentity name="Commons 開発チーム" handle="commons_dev" createdAt="2026-07-01 00:00:00" />,
    );
    expect(html).toContain("公式");
  });
});

describe("PostReactionCounts", () => {
  it("labels each count for screen readers", () => {
    const html = renderToStaticMarkup(<PostReactionCounts replies={1} reposts={2} likes={3} />);
    expect(html).toContain("返信");
    expect(html).toContain("リポスト");
    expect(html).toContain("いいね");
    expect(html).toContain(">1<");
    expect(html).toContain(">2<");
    expect(html).toContain(">3<");
  });
});

describe("PostSummaryCard", () => {
  const post = {
    id: "post_x",
    name: "あおい",
    handle: "aoi_note",
    body: "テスト本文です",
    createdAt: "2026-07-01 00:00:00",
    replies: 0,
    reposts: 1,
    likes: 2,
  };

  it("renders the post body with identity and counts", () => {
    const html = renderToStaticMarkup(<PostSummaryCard post={post} />);
    expect(html).toContain("テスト本文です");
    expect(html).toContain("@aoi_note");
    expect(html).toContain("いいね");
  });

  it("renders the optional action and children slots", () => {
    const html = renderToStaticMarkup(
      <PostSummaryCard post={post} action={<button>削除ボタン</button>}>
        <div>エラー表示</div>
      </PostSummaryCard>,
    );
    expect(html).toContain("削除ボタン");
    expect(html).toContain("エラー表示");
  });
});
