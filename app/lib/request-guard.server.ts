/**
 * POST アクション共通の門番（クロスサイト送信の遮断と、本文サイズの上限）。
 *
 * どちらも「セッションを引く前・本文を読む前」に効かせる必要があるので、
 * 各ルートの `action` の冒頭で必ず通す。判定はヘッダの比較だけなので CPU は 0。
 */

/**
 * テキストフォーム1通ぶんの上限バイト数（32KiB）。
 *
 * 投稿本文 280 文字・自己紹介 160 文字・パスワード 128 文字という上限からすると
 * 桁違いに大きい値で、正規の送信が触れることはない。
 */
export const FORM_BODY_MAX_BYTES = 32_768;

/** 本文が上限を超えた（あるいは長さを申告しない）ときの利用者向けメッセージ。 */
export const FORM_TOO_LARGE_MESSAGE = "送信内容が大きすぎます。";

/** 本文を form として読めなかったときの利用者向けメッセージ。 */
export const FORM_UNREADABLE_MESSAGE = "問題が発生しました。時間をおいてもう一度お試しください。";

/**
 * クロスサイト送信を判定する。
 *
 * ブラウザが自分で付けるヘッダ（利用者側の JS からは上書きできない）だけを見る。
 *
 * - `Sec-Fetch-Site: cross-site` … 別サイトからの送信であるとブラウザが宣言している
 * - `Origin` が request URL の origin と不一致 … 同上（`Origin: null` も不一致として弾く）
 *
 * どちらのヘッダも無い送信は通す。テストや curl・古いクライアントを壊さないためで、
 * ここで守りたいのは**ブラウザ経由の**クロスサイト送信だから成立する。
 *
 * 主目的は**ログイン CSRF** の遮断。攻撃者が自分の資格情報で被害者のブラウザに
 * ログインさせると、以後の投稿・ブックマークが攻撃者のアカウントへ流れ込む。
 * セッション Cookie は `SameSite=Lax` なので副作用のある POST は元々届かないが、
 * ログインは Cookie が無くても成立するため SameSite では防げない。
 */
export function isCrossSiteRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) return true;
  return false;
}

/**
 * クロスサイト送信なら 403 応答を返す。同一サイト（と判定材料が無い送信）は null。
 *
 * 呼び出し側は `const rejected = crossSiteRejection(request); if (rejected) return rejected;`
 * と書く。応答は素の `Response` で、React Router はそのまま返す。
 */
export function crossSiteRejection(request: Request): Response | null {
  if (!isCrossSiteRequest(request)) return null;
  return new Response("不正な送信元です。", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** {@link readFormDataBounded} の結果。失敗時はそのまま応答へ写せる形で返す。 */
export type BoundedFormDataResult =
  { ok: true; formData: FormData } | { ok: false; status: 413 | 500; message: string };

/**
 * 本文サイズの門番を通してから `request.formData()` を読む。
 *
 * 【必須】`formData()` を呼んだ時点で本文は isolate のヒープへ全部展開される。
 * Cloudflare はリクエストボディを 100MB（プランによってはそれ以上）まで通すので、
 * この門番が無いと巨大なボディを数本投げるだけで isolate のメモリ上限（128MB）を
 * 踏ませられる。isolate が作り直されるとレートリミットのバケツ（module スコープの
 * Map）もまるごと消えるため、「大きなボディで isolate を回して上限を無効化する」
 * 経路になる。
 *
 * 長さを申告しないリクエストも弾く（安全側）。ブラウザは `<form>` 送信でも
 * `fetch` の FormData / URLSearchParams 本文でも必ず `Content-Length` を付けるので、
 * 正規の経路は影響を受けない。
 *
 * @param maxBytes 本文の上限。省略時は {@link FORM_BODY_MAX_BYTES}。
 */
export async function readFormDataBounded(
  request: Request,
  maxBytes: number = FORM_BODY_MAX_BYTES,
): Promise<BoundedFormDataResult> {
  const declared = request.headers.get("content-length");
  const declaredBytes = declared === null ? Number.NaN : Number(declared);
  if (!Number.isFinite(declaredBytes) || declaredBytes > maxBytes) {
    return { ok: false, status: 413, message: FORM_TOO_LARGE_MESSAGE };
  }
  try {
    return { ok: true, formData: await request.formData() };
  } catch (error) {
    console.error("form body read failed", error);
    return { ok: false, status: 500, message: FORM_UNREADABLE_MESSAGE };
  }
}
