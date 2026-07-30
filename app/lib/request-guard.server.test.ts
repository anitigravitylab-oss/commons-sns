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

/** 直近の {@link streamingPostRequest} が読み手へ渡したチャンク数。 */
let pulledChunks = 0;
/** 直近の {@link streamingPostRequest} の本文が、読み切られる前に捨てられたか。 */
let streamCancelled = false;

/**
 * ストリーム本文の POST（`Content-Length` は付かない）。
 *
 * チャンクは要求されたときだけ流すので、読み手が途中で打ち切ったかどうかを
 * {@link pulledChunks} と {@link streamCancelled} で観察できる。
 */
function streamingPostRequest(parts: string[], headers: Record<string, string> = {}): Request {
  const encoder = new TextEncoder();
  pulledChunks = 0;
  streamCancelled = false;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= parts.length) {
        controller.close();
        return;
      }
      pulledChunks += 1;
      controller.enqueue(encoder.encode(parts[index]));
      index += 1;
    },
    cancel() {
      streamCancelled = true;
    },
  });
  return new Request(URL_ACTION, {
    method: "POST",
    body: stream,
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    // @ts-expect-error ストリーム本文には duplex 指定が要る（型定義にはまだ無い）
    duplex: "half",
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

  it("Content-Length を申告しない本文は、数えたうえで通す", async () => {
    // HTTP/2 の本文や `fetch` のストリーミング送信には Content-Length が付かない
    // （fetch では禁止ヘッダなので送信側から付けようがない）。ここで一律に落とすと
    // 正規の送信まで 413 になる。
    const request = streamingPostRequest(["intent=createPost", "&body=hello"]);

    const result = await readFormDataBounded(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.formData.get("intent")).toBe("createPost");
    expect(result.formData.get("body")).toBe("hello");
  });

  it("Content-Length を申告しない本文は、上限を超えた時点で読み取りを打ち切って 413", async () => {
    const chunk = "x".repeat(32);
    const request = streamingPostRequest(Array.from({ length: 8 }, () => chunk));

    // 32 バイトのチャンクを 3 つ読んだ時点（96 > 64）で超過が確定するので、
    // 残りは受け取らずに捨てる。全部読んでから判定すると上限が意味を失う。
    expect(await readFormDataBounded(request, 64)).toMatchObject({ ok: false, status: 413 });
    expect(pulledChunks).toBeLessThan(8);
    expect(streamCancelled).toBe(true);
  });

  it("巨大なチャンクを1つ送られても、一度に受け取る量はバッファで抑える", async () => {
    // チャンクの大きさは Fetch の仕様では上限が無い。受け取ってから判定する読み方だと、
    // 上限超過と分かる前にチャンク1つぶんがまるごとヒープへ載り、門番の目的
    // （isolate のメモリ保護）を大きな1チャンクで迂回できてしまう。
    let maxViewBytes = 0;
    let servedBytes = 0;
    const stream = new ReadableStream({
      type: "bytes",
      pull(controller) {
        const view = controller.byobRequest?.view;
        if (!view) {
          // BYOB で読まれなかった場合（フォールバック経路）はまとめて渡す。
          controller.enqueue(new Uint8Array(256 * 1_024));
          return;
        }
        maxViewBytes = Math.max(maxViewBytes, view.byteLength);
        servedBytes += view.byteLength;
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(0x78); // "x"
        controller.byobRequest.respond(view.byteLength);
      },
    });
    const request = new Request(URL_ACTION, {
      method: "POST",
      body: stream,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // @ts-expect-error ストリーム本文には duplex 指定が要る（型定義にはまだ無い）
      duplex: "half",
    });

    expect(await readFormDataBounded(request, 32_768)).toMatchObject({ ok: false, status: 413 });
    // 1回の読み取りで受け取るのは、こちらが用意した器のぶんだけ。
    expect(maxViewBytes).toBeGreaterThan(0); // BYOB で読めていること（0 ならフォールバックしている）
    expect(maxViewBytes).toBeLessThanOrEqual(8_192);
    // 上限を大きく超えて読み続けてはいない（超過が分かった時点で打ち切る）。
    expect(servedBytes).toBeLessThanOrEqual(32_768 + 8_192);
  });

  it("数値として読めない Content-Length は申告を信用せず、実際の長さで判定する", async () => {
    const request = streamingPostRequest(["intent=noop"], { "Content-Length": "not-a-number" });
    expect(request.headers.get("content-length")).toBe("not-a-number");

    expect(await readFormDataBounded(request)).toMatchObject({ ok: true });
  });

  it("上限は呼び出し側が広げられる（将来の大きな本文を扱うルート用）", async () => {
    const request = postRequest({ "Content-Length": String(FORM_BODY_MAX_BYTES + 1) });

    expect(await readFormDataBounded(request, FORM_BODY_MAX_BYTES * 2)).toMatchObject({ ok: true });
  });

  it("読み取りの途中で壊れた本文は 500（BYOB と既定の両方の経路）", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const brokenRequest = (options: { bytes: boolean }) =>
        new Request(URL_ACTION, {
          method: "POST",
          body: new ReadableStream({
            ...(options.bytes ? { type: "bytes" as const } : {}),
            pull(controller) {
              controller.error(new Error("stream broke"));
            },
          }),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          // @ts-expect-error ストリーム本文には duplex 指定が要る（型定義にはまだ無い）
          duplex: "half",
        });

      // バイトストリーム = BYOB で読む経路。
      expect(await readFormDataBounded(brokenRequest({ bytes: true }))).toMatchObject({ ok: false, status: 500 });
      // バイトストリームでない = 既定の読み取りに落ちる経路。
      expect(await readFormDataBounded(brokenRequest({ bytes: false }))).toMatchObject({ ok: false, status: 500 });
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
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
