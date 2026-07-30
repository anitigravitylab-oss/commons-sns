/**
 * isolate メモリ上のトークンバケツによる軽量レートリミット。
 *
 * Durable Objects や KV などの追加インフラなしで動く、依存ゼロの仕組み。
 * isolate はコロケーション単位で使い捨てられるため厳密な制限にはならないが、
 * スパム・総当たり・連打への一次防御としては十分であり、CPU コストは
 * Map の get/set だけで無視できる。
 *
 * **バケツは isolate のメモリにしか無い**。コロを分散されたり、isolate が
 * 作り直されたりすると残量は初期化される（＝上限は「最悪ケースの下限」でしかない）。
 * ストレージのように取り返しがつかない資源は、これとは別の永続的な上限で守ること。
 */

export type RateLimitRule = { readonly capacity: number; readonly refillPerSecond: number };
export type RateLimitVerdict = { allowed: boolean; retryAfterSeconds: number };

/**
 * 書き込み系アクションの上限。小規模インスタンス想定のため、通常利用では
 * 絶対に当たらない値にしてある。
 */
export const RATE_LIMITS = {
  /** 登録: IP あたり 3件/時 */
  signup: { capacity: 3, refillPerSecond: 3 / 3_600 },
  /**
   * ログイン試行: IP あたり 10回/10分。
   *
   * 対象アカウント単位の枠は**意図的に持たない**。試行の時点で消費する口座単位の
   * バケツは、第三者がわざと間違ったパスワードを投げ続けるだけで正規の持ち主まで
   * 締め出せてしまう（ログインDoS）。失敗だけを数えて成功を通す形にするには
   * isolate をまたぐ永続的な失敗記録が必要になるため、ここでは扱わない。
   */
  login: { capacity: 10, refillPerSecond: 10 / 600 },
  /** 投稿: ユーザーあたり 10件/分 */
  post: { capacity: 10, refillPerSecond: 10 / 60 },
  /** リアクション（削除もこの枠を共有）: ユーザーあたり 60回/分 */
  reaction: { capacity: 60, refillPerSecond: 1 },
  /** フォロー切替: ユーザーあたり 30回/分 */
  follow: { capacity: 30, refillPerSecond: 0.5 },
  /** プロフィール更新: ユーザーあたり 10回/5分 */
  profile: { capacity: 10, refillPerSecond: 10 / 300 },
  /**
   * パスワード変更・退会（PBKDF2 で CPU が重い）: 「利用者 × 送信元」あたり 5回/10分。
   *
   * 主体に送信元を混ぜるのが要点。利用者だけを主体にすると、盗まれたセッションを
   * 持つ第三者が失敗する送信で枠を空にし、本人の復旧操作（パスワード変更・退会）を
   * 締め出せてしまう。
   */
  credential: { capacity: 5, refillPerSecond: 5 / 600 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

/** isolate メモリ保護のためのバケツ数上限。 */
export const MAX_BUCKETS = 4_000;

/** 超過時にユーザーへ見せる文言。ルート側の ActionResult に載せる。 */
export const RATE_LIMIT_MESSAGE = "操作が多すぎます。しばらく待ってからお試しください。";

type Bucket = { tokens: number; updatedAt: number; rule: RateLimitRule };

const buckets = new Map<string, Bucket>();

/**
 * ローカル開発（`react-router dev`）では制限を掛けない。
 *
 * e2e は 1 クライアントから何十回も登録・投稿を繰り返すため、本番向けの上限を
 * そのまま当てると通らない。vitest は `MODE === "test"`、本番ビルドは
 * `"production"` なので、どちらも制限は有効なまま。
 */
const DISABLED = import.meta.env.MODE === "development";

/**
 * IPv6 アドレスを /64 プレフィックスへ丸める。
 *
 * IPv6 は1契約に /64（以上）がまるごと配られるのが普通で、アドレスそのものを
 * 主体にすると、同じ相手が1リクエストごとに別のアドレスを名乗って上限を
 * 無効化できる（バケツの上限まで埋めて他人の記録を押し出すこともできる）。
 * 先頭4グループ（64 ビット）だけを見れば、その契約全体で1つの枠になる。
 */
function ipv6Prefix(address: string): string {
  // `::ffff:192.0.2.1` のような IPv4 射影アドレスは IPv4 として扱う
  // （丸めると射影アドレス全体が1つの枠に潰れてしまう）。
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1];

  const [head, tail] = address.split("::");
  const headGroups = head ? head.split(":") : [];
  const groups =
    tail === undefined
      ? headGroups
      : // 省略された 0 のグループを補ってから先頭を取る。
        [
          ...headGroups,
          ...Array.from(
            { length: Math.max(8 - headGroups.length - (tail ? tail.split(":").length : 0), 0) },
            () => "0",
          ),
          ...(tail ? tail.split(":") : []),
        ];
  // 表記ゆれ（大文字・先頭の 0）を潰してから連結する。
  return `${groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/**
 * レート制限の主体キー。Cloudflare が付与するクライアント IP だけを使う。
 *
 * `X-Forwarded-For` にはフォールバックしない。Cloudflare は（`CF-Connecting-IP` と
 * 違い）このヘッダを上書きしないので、クライアントが自由に詐称でき、1リクエストごとに
 * 別の主体を名乗って上限を無効化できてしまう。取れない場合（ローカル実行やテスト）は
 * "unknown" にまとめる ＝ 全員で1つのバケツを共有する安全側の挙動になる。
 *
 * IPv6 は {@link ipv6Prefix} で /64 に丸める。IPv4 はアドレスのままで、
 * NAT の後ろが1つの枠を共有する（これは IPv4 では避けられない）。
 */
export function clientKey(request: Request): string {
  const address = request.headers.get("CF-Connecting-IP")?.trim();
  if (!address) return "unknown";
  return address.includes(":") ? ipv6Prefix(address) : address;
}

/** 経過時間ぶんを補充したトークン残量。 */
function refill(bucket: Bucket, now: number): number {
  const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1_000);
  return Math.min(bucket.rule.capacity, bucket.tokens + elapsedSeconds * bucket.rule.refillPerSecond);
}

/** 満タンのバケツが1つも無いときに、最古から追い出す件数。 */
const EVICTION_BATCH = Math.max(1, Math.floor(MAX_BUCKETS / 100));

/**
 * バケツ数が上限に達したら、満タンに戻ったバケツ（＝もう情報を持たないバケツ）から捨てる。
 *
 * それでも空かない場合でも全消去はしない。全消去すると、攻撃者が異なる主体キーを
 * `MAX_BUCKETS` 個作るだけで自分の signup / login カウンタまで消せてしまい、
 * 上限そのものが無効になる。Map の反復順＝挿入順なので、最古のバケツから
 * `EVICTION_BATCH` 件だけ落として直近の記録を残す。
 */
function evictIfFull(now: number) {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (refill(bucket, now) >= bucket.rule.capacity) buckets.delete(key);
  }
  if (buckets.size < MAX_BUCKETS) return;
  let removed = 0;
  for (const key of buckets.keys()) {
    if (removed >= EVICTION_BATCH) break;
    buckets.delete(key);
    removed += 1;
  }
}

/**
 * トークンを1つ消費する。
 *
 * @param name 適用するルール。
 * @param subject 主体（IP かユーザー ID）。
 * @param now 現在時刻（ミリ秒）。テストから注入する。
 */
export function consumeToken(name: RateLimitName, subject: string, now: number = Date.now()): RateLimitVerdict {
  if (DISABLED) return { allowed: true, retryAfterSeconds: 0 };
  const rule = RATE_LIMITS[name];
  const key = `${name}:${subject}`;
  const existing = buckets.get(key);
  let tokens: number;
  if (existing) {
    tokens = refill(existing, now);
  } else {
    evictIfFull(now);
    tokens = rule.capacity;
  }

  // 時計が巻き戻ったときは、記録済みの時刻を後退させない。古い時刻で上書きすると、
  // 時計が元に戻ったときに同じ区間がもう一度「経過した」ものとして補充され、
  // 巻き戻し幅ぶんだけ上限を素通しできてしまう（`refill` は経過が負なら補充しない
  // ので、後退させないかぎり巻き戻し中も残量は据え置きになる）。
  const updatedAt = existing ? Math.max(now, existing.updatedAt) : now;

  // Map の反復順は「最初に入れた順」で、既存キーへの再代入では末尾へ動かない。
  // 追い出し（`evictIfFull`）は反復順の先頭から捨てるので、入れ直さないと
  // 「いま連打を弾いている最中のバケツ」が、放置された新しいバケツより先に
  // 落ちてしまい、その相手のカウンタだけが満タンに戻る。
  if (existing) buckets.delete(key);

  if (tokens < 1) {
    buckets.set(key, { tokens, updatedAt, rule });
    // tokens < 1 なので (1 - tokens) は必ず正、切り上げ結果も必ず 1 以上になる。
    return { allowed: false, retryAfterSeconds: Math.ceil((1 - tokens) / rule.refillPerSecond) };
  }
  buckets.set(key, { tokens: tokens - 1, updatedAt, rule });
  return { allowed: true, retryAfterSeconds: 0 };
}

/** 429 応答の ResponseInit。`Retry-After` は秒数で返す。 */
export function rateLimitResponseInit(verdict: RateLimitVerdict): ResponseInit {
  return { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } };
}

/** テスト用。全バケツを消す。 */
export function resetRateLimits(): void {
  buckets.clear();
}
