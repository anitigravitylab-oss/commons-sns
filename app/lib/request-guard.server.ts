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

/** `formData()` として読む。読めなければ 500（本文の形式が想定外）。 */
async function parseFormData(source: Request): Promise<BoundedFormDataResult> {
  try {
    return { ok: true, formData: await source.formData() };
  } catch (error) {
    console.error("form body read failed", error);
    return { ok: false, status: 500, message: FORM_UNREADABLE_MESSAGE };
  }
}

/**
 * 長さの申告が無い本文を読むとき、1回の読み取りで受け取る最大バイト数（8KiB）。
 *
 * ストリームのチャンクの大きさは Fetch の仕様では上限が無く、送信側とランタイムの
 * 都合で決まる。既定の読み取りだと「上限超過だと分かる前に、チャンク1つぶんが
 * まるごとヒープへ載る」ので、大きなチャンクを1つ送るだけでこの門番の目的
 * （isolate のメモリ保護）を迂回できてしまう。受け取る器の大きさをこちらで決めれば、
 * 一度に載るのはこのサイズまでになる。
 */
const STREAM_CHUNK_BYTES = 8_192;

/** 読み取ったチャンク列、または失敗（そのまま応答へ写せる形）。 */
type CollectedBody =
  { ok: true; chunks: Uint8Array[]; total: number } | { ok: false; status: 413 | 500; message: string };

/** BYOB リーダーを取る。バイトストリームでなければ null（既定の読み取りに落ちる）。 */
function byobReaderOf(body: ReadableStream<Uint8Array>): ReadableStreamBYOBReader | null {
  try {
    return body.getReader({ mode: "byob" });
  } catch {
    return null;
  }
}

/**
 * BYOB で読む。渡したバッファより多くは一度に受け取らないので、上限判定より前に
 * ヒープへ載るのは高々 {@link STREAM_CHUNK_BYTES} ぶんになる。
 */
async function collectViaByob(reader: ReadableStreamBYOBReader, maxBytes: number): Promise<CollectedBody> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let buffer = new ArrayBuffer(STREAM_CHUNK_BYTES);
  // 次のチャンクは前のチャンクを読み終えてからしか来ない。まとめられる待ち合わせが
  // 無いので、ここは逐次の await が唯一の読み方になる。
  /* oxlint-disable no-await-in-loop */
  try {
    for (;;) {
      const { done, value } = await reader.read(new Uint8Array(buffer));
      // 打ち切り済みでも done が立つ。value が無い場合はそこで終わり。
      if (done || value === undefined) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // 残りは受け取らない。ここで捨てないと上限が意味を失う。
        await reader.cancel();
        return { ok: false, status: 413, message: FORM_TOO_LARGE_MESSAGE };
      }
      // `value` は次の読み取りで書き換える器の一部なので、内容をコピーして保持する。
      chunks.push(new Uint8Array(value));
      // 渡したバッファは read のたびに detach される。返ってきた側を次に使う。
      buffer = value.buffer;
    }
  } catch (error) {
    console.error("form body read failed", error);
    return { ok: false, status: 500, message: FORM_UNREADABLE_MESSAGE };
  }
  /* oxlint-enable no-await-in-loop */
  return { ok: true, chunks, total };
}

/**
 * 既定の読み取り（BYOB を持たないストリーム用）。チャンクの大きさは選べないので、
 * 受け取った時点で上限を超えていれば、その場で打ち切る。
 */
async function collectViaDefault(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<CollectedBody> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  /* oxlint-disable no-await-in-loop */
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, message: FORM_TOO_LARGE_MESSAGE };
      }
      chunks.push(value);
    }
  } catch (error) {
    console.error("form body read failed", error);
    return { ok: false, status: 500, message: FORM_UNREADABLE_MESSAGE };
  }
  /* oxlint-enable no-await-in-loop */
  return { ok: true, chunks, total };
}

/**
 * 長さの申告が無い本文を、上限まで数えながら読む。
 *
 * 上限を超えた時点で読み取りを打ち切って残りを捨てるので、ヒープに載るのは
 * 高々 `maxBytes` ぶん＋1回の読み取りぶんで、申告ありの経路と同じ上限で抑えられる。
 */
async function readBoundedBody(request: Request, maxBytes: number): Promise<BoundedFormDataResult> {
  // 本文が無い送信（空のフォーム）はそのまま渡す。
  if (request.body === null) return parseFormData(request);

  const byob = byobReaderOf(request.body);
  const collected = byob
    ? await collectViaByob(byob, maxBytes)
    : await collectViaDefault(request.body.getReader(), maxBytes);
  if (!collected.ok) return collected;

  const body = new Uint8Array(collected.total);
  let offset = 0;
  for (const chunk of collected.chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // 解析（urlencoded と multipart の区別、boundary の扱い）は自前でやらず、
  // 元のヘッダごと載せ直して `formData()` に任せる。
  return parseFormData(new Request(request.url, { method: "POST", headers: request.headers, body }));
}

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
 * 判定は2段階に分かれる。
 *
 * 1. `Content-Length` が上限超過を申告している送信は、本文にいっさい触れずに落とす。
 * 2. 長さの申告が無い（あるいは数値として読めない）送信は、上限まで数えながら読み、
 *    超えた時点で打ち切る。HTTP/2 の本文やストリーミング送信には `Content-Length` が
 *    付かない（fetch では禁止ヘッダなので送信側から付けようがない）ため、ここで一律に
 *    落とすと正規の送信まで 413 になってしまう。
 *
 * @param maxBytes 本文の上限。省略時は {@link FORM_BODY_MAX_BYTES}。
 */
export async function readFormDataBounded(
  request: Request,
  maxBytes: number = FORM_BODY_MAX_BYTES,
): Promise<BoundedFormDataResult> {
  const declared = request.headers.get("content-length");
  const declaredBytes = declared === null ? Number.NaN : Number(declared);
  if (Number.isFinite(declaredBytes)) {
    if (declaredBytes > maxBytes) {
      return { ok: false, status: 413, message: FORM_TOO_LARGE_MESSAGE };
    }
    // 申告と実際の本文が食い違う送信はプロトコル側で弾かれる（HTTP/1.1 は
    // Content-Length で本文を区切り、HTTP/2 は不一致を malformed として扱う）ので、
    // 上限内の申告はそのまま信用してよい。
    return parseFormData(request);
  }
  return readBoundedBody(request, maxBytes);
}
