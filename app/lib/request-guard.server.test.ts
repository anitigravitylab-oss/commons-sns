import { describe, expect, it, vi } from "vitest";
import {
  crossSiteRejection,
  FORM_BODY_MAX_BYTES,
  FORM_TOO_LARGE_MESSAGE,
  isCrossSiteRequest,
  readFormDataBounded,
} from "./request-guard.server";

const URL_ACTION = "http://test.local/";

function postRequest(headers: Record<string, string>, body = "intent=noop"): Request {
  return new Request(URL_ACTION, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
      ...headers,
    },
  });
}

describe("isCrossSiteRequest", () => {
  it("判定材料が無い送信は通す（テスト・非ブラウザのクライアント）", () => {
    expect(isCrossSiteRequest(postRequest({}))).toBe(false);
  });

  it("同一 origin の送信は通す", () => {
    expect(isCrossSiteRequest(postRequest({ Origin: "http://test.local" }))).toBe(false);
    expect(isCrossSiteRequest(postRequest({ "Sec-Fetch-Site": "same-origin" }))).toBe(false);
    // サブドメイン間（same-site）はブラウザが宣言していれば通す。
    expect(isCrossSiteRequest(postRequest({ "Sec-Fetch-Site": "same-site" }))).toBe(false);
    // アドレスバー直打ち・リンク経由。
    expect(isCrossSiteRequest(postRequest({ "Sec-Fetch-Site": "none" }))).toBe(false);
  });

  it("origin が違う送信を弾く（ポート・スキーム違いも別 origin）", () => {
    expect(isCrossSiteRequest(postRequest({ Origin: "https://evil.example" }))).toBe(true);
    expect(isCrossSiteRequest(postRequest({ Origin: "http://test.local:8080" }))).toBe(true);
    expect(isCrossSiteRequest(postRequest({ Origin: "https://test.local" }))).toBe(true);
    // サンドボックス iframe などが送る不透明な origin。
    expect(isCrossSiteRequest(postRequest({ Origin: "null" }))).toBe(true);
  });

  it("Sec-Fetch-Site: cross-site を弾く（Origin が同一でも）", () => {
    expect(isCrossSiteRequest(postRequest({ "Sec-Fetch-Site": "cross-site" }))).toBe(true);
    expect(isCrossSiteRequest(postRequest({ "Sec-Fetch-Site": "cross-site", Origin: "http://test.local" }))).toBe(true);
  });
});

describe("crossSiteRejection", () => {
  it("同一サイトの送信では null を返す", () => {
    expect(crossSiteRejection(postRequest({ Origin: "http://test.local" }))).toBeNull();
  });

  it("クロスサイトでは 403 の Response を返す", async () => {
    const rejected = crossSiteRejection(postRequest({ Origin: "https://evil.example" }));

    expect(rejected?.status).toBe(403);
    expect(await rejected?.text()).toContain("不正な送信元");
  });
});

describe("readFormDataBounded", () => {
  it("上限内の本文はそのまま FormData として返す", async () => {
    const result = await readFormDataBounded(postRequest({}, "intent=createPost&body=hello"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.formData.get("intent")).toBe("createPost");
    expect(result.formData.get("body")).toBe("hello");
  });

  it("Content-Length が上限を超えていれば本文を読まずに 413", async () => {
    const request = postRequest({ "Content-Length": String(FORM_BODY_MAX_BYTES + 1) });

    const result = await readFormDataBounded(request);

    expect(result).toEqual({ ok: false, status: 413, message: FORM_TOO_LARGE_MESSAGE });
    // formData() を呼んだ時点で本文は isolate のヒープに載る。門番はその前に効く必要がある。
    expect(request.bodyUsed).toBe(false);
  });

  it("Content-Length を申告しない本文も 413（安全側に倒す）", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("intent=noop"));
        controller.close();
      },
    });
    const request = new Request(URL_ACTION, {
      method: "POST",
      body: stream,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // @ts-expect-error ストリーム本文には duplex 指定が要る（型定義にはまだ無い）
      duplex: "half",
    });

    expect(await readFormDataBounded(request)).toMatchObject({ ok: false, status: 413 });
    expect(request.bodyUsed).toBe(false);
  });

  it("上限は呼び出し側が広げられる（将来の大きな本文を扱うルート用）", async () => {
    const request = postRequest({ "Content-Length": String(FORM_BODY_MAX_BYTES + 1) });

    expect(await readFormDataBounded(request, FORM_BODY_MAX_BYTES * 2)).toMatchObject({ ok: true });
  });

  it("フォームとして読めない本文は 500", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const request = new Request(URL_ACTION, {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json", "Content-Length": "2" },
      });

      expect(await readFormDataBounded(request)).toMatchObject({ ok: false, status: 500 });
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
