/**
 * 一覧データのクライアントキャッシュ（IndexedDB）。
 *
 * ローダーの結果をブラウザに保存し、クライアント遷移で戻ってきたときに即時表示する。
 * さらに短い鮮度ウィンドウ（{@link CACHE_FRESH_MS}）の内側では再フェッチ自体を省略するので、
 * Workers のリクエスト数と D1 の読み取り行数をそのぶん減らせる。
 *
 * 設計上の原則:
 * - **プログレッシブエンハンスメント**: IndexedDB が無い環境（SSR・プライベートモード・
 *   古いブラウザ）ではすべての関数が「キャッシュ無し」として振る舞い、機能は落ちない。
 * - **他ユーザーのデータを混ぜない**: レコードに閲覧者 ID を持たせ、一致しなければ捨てる。
 * - **書き込み後に古い一覧を出さない**: 送信を検知した時刻より前のレコードは使わない。
 *
 * IndexedDB へのアクセスは {@link CacheStore} 越しに行う。テストではメモリ実装を差し込めるので、
 * 追加依存なしで Node 環境の vitest からロジックを検証できる。
 */

/** キャッシュ DB 名。 */
export const CACHE_DB_NAME = "commons-sns-view-cache";
/** スキーマバージョン。上げると既存ストアを破棄して作り直す。 */
export const CACHE_DB_VERSION = 1;
/** オブジェクトストア名。 */
export const CACHE_STORE_NAME = "views";
/** これより新しいレコードは再フェッチを省略してそのまま表示する。 */
export const CACHE_FRESH_MS = 30_000;
/** これより古いレコードは使わずに捨てる。 */
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/** 未ログインの閲覧者を表す所有者 ID。 */
export const GUEST_OWNER = "guest";

/** ローダーの結果をどこから得たか。ルート側の再検証判断に使う。 */
export type CacheOutcome = "fresh-cache" | "stale-cache" | "network";

export type CachedRecord = {
  key: string;
  /** 閲覧者の同一性。ログイン中は user.id、未ログインは {@link GUEST_OWNER}。 */
  owner: string;
  /** Date.now() */
  savedAt: number;
  payload: unknown;
};

/** IndexedDB の薄いラッパ。テストではメモリ実装に差し替える。 */
export type CacheStore = {
  get(key: string): Promise<CachedRecord | undefined>;
  put(record: CachedRecord): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
};

/**
 * キャッシュキーの組み立て。ここを通さずに文字列を直書きしない。
 *
 * 「未読の鮮度」が本質になる一覧（将来の通知など）は意図的にキャッシュしない方針。
 */
export const cacheKeys = {
  timeline: (tab: "recommended" | "following") => `timeline:${tab}`,
  /** ページ番号を含める。ページが同じキーを共有すると2ページ目に1ページ目が出る。 */
  bookmarks: (page: number) => `bookmarks:${page}`,
  /** ハンドルは大文字小文字を区別しない（URL 上の表記ゆれで別キーにしない）。 */
  profile: (handle: string, page: number) => `profile:${handle.toLowerCase()}:${page}`,
  /** フォロー一覧。フォロー中とフォロワーで中身が違うので種別をキーに含める。 */
  followList: (handle: string, kind: "following" | "followers", page: number) =>
    `follows:${handle.toLowerCase()}:${kind}:${page}`,
};

/** IndexedDB から読んだ値が期待する形かを確かめる（版ずれ・手動改変への防御）。 */
function isCachedRecord(value: unknown): value is CachedRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<CachedRecord>;
  return typeof record.key === "string" && typeof record.owner === "string" && typeof record.savedAt === "number";
}

/** IDBRequest を Promise 化する。失敗は例外にせず undefined で返す。 */
function requestValue<T>(request: IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
}

/** DB を開く。開けない場合（容量超過・プライベートモード等）は null。 */
function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
    } catch (error) {
      console.warn("client cache: open failed", error);
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      // 版を上げたら中身は作り直す。形の違う古いレコードを読まないための単純な戦略。
      if (db.objectStoreNames.contains(CACHE_STORE_NAME)) db.deleteObjectStore(CACHE_STORE_NAME);
      db.createObjectStore(CACHE_STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // 別タブが古い版を開いたままだと upgrade がブロックされる。待たずに諦める。
    request.onblocked = () => resolve(null);
  });
}

/** IndexedDB が使えないときは null を返す（プログレッシブエンハンスメント）。 */
export function createIndexedDbStore(): CacheStore | null {
  if (typeof indexedDB === "undefined") return null;

  let connection: Promise<IDBDatabase | null> | null = null;
  const connect = () => (connection ??= openDatabase());

  const run = async <T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T | undefined> => {
    const db = await connect();
    if (!db) return undefined;
    try {
      const transaction = db.transaction(CACHE_STORE_NAME, mode);
      return await requestValue(body(transaction.objectStore(CACHE_STORE_NAME)));
    } catch (error) {
      console.warn("client cache: transaction failed", error);
      return undefined;
    }
  };

  return {
    async get(key) {
      const value = await run<unknown>("readonly", (store) => store.get(key));
      return isCachedRecord(value) ? value : undefined;
    },
    async put(record) {
      await run("readwrite", (store) => store.put(record));
    },
    async delete(key) {
      await run("readwrite", (store) => store.delete(key));
    },
    async clear() {
      await run("readwrite", (store) => store.clear());
    },
  };
}

/** undefined は「未解決」、null は「使えない」。 */
let resolvedStore: CacheStore | null | undefined;
/** 最後にサーバーから受け取った閲覧者 ID のヒント。 */
let lastViewer: string = GUEST_OWNER;
/** このタブが閲覧者ヒントを最後に観測した時刻（タブ間の新旧比較用）。 */
let lastViewerAt = 0;
/** 直近の書き込み操作の時刻。これ以前のレコードは信用しない。 */
let lastMutationAt = 0;
/** 次回だけキャッシュを無視するキー。 */
const bypassKeys = new Set<string>();

/**
 * 閲覧者ヒントと書き込み時刻の localStorage キー。
 *
 * IndexedDB のレコードは最長24時間残るうえタブ間で共有されるのに、この2つが
 * モジュールメモリにしか無いと (1) 書き込み直後のリロードで無効化の記録が消える、
 * (2) 別タブで起きた投稿・ログインをこのタブが観測できない、という取りこぼしが
 * 起こる。レコードと寿命・共有範囲をそろえるため localStorage に置き、
 * 読み書きの入り口ごとに合流（マージ）する。
 */
const PERSIST_KEY = "commons-sns-view-cache-state";

type PersistedCacheState = { viewer: string; viewerAt: number; mutationAt: number };

/** 保存値を読む。無い・壊れている・localStorage が使えない環境は null。 */
function readPersistedState(): PersistedCacheState | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedCacheState>;
    if (typeof parsed.viewer !== "string") return null;
    if (typeof parsed.mutationAt !== "number" || !Number.isFinite(parsed.mutationAt)) return null;
    const viewerAt = typeof parsed.viewerAt === "number" && Number.isFinite(parsed.viewerAt) ? parsed.viewerAt : 0;
    return { viewer: parsed.viewer, viewerAt, mutationAt: parsed.mutationAt };
  } catch {
    // 壊れた値・プライベートモード。メモリ内の値だけで従来どおり動く。
    return null;
  }
}

/**
 * 保存値とメモリ内の状態を合流させる。読み書きの入り口ごとに呼ぶ。
 *
 * **一度きりの読み込みでは足りない。** 開きっぱなしのタブは、別タブの投稿や
 * ログアウトが書いた新しい記録を観測できず、共有 IndexedDB の古いレコードを
 * 「新鮮」として返してしまう。書き込み時刻は大きいほう、閲覧者ヒントは
 * 観測時刻が新しいほうを採用する。
 */
function syncPersistedState(): void {
  const persisted = readPersistedState();
  if (!persisted) return;
  lastMutationAt = Math.max(lastMutationAt, persisted.mutationAt);
  if (persisted.viewerAt > lastViewerAt) {
    lastViewer = persisted.viewer;
    lastViewerAt = persisted.viewerAt;
  }
}

/**
 * メモリ内の状態を保存する。
 *
 * 自分の値で単純に上書きすると、古いタブが新しいタブの記録を巻き戻せてしまう
 * （巻き戻った無効化時刻は、リロード後に古いレコードを復活させる）。
 * 必ず現在の保存値と合流してから書く。localStorage が無い環境では黙って諦める。
 */
function persistState(): void {
  try {
    if (typeof localStorage === "undefined") return;
    syncPersistedState();
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({ viewer: lastViewer, viewerAt: lastViewerAt, mutationAt: lastMutationAt }),
    );
  } catch {
    // 容量超過やプライベートモード。メモリ内の値だけで従来どおり動く。
  }
}

function activeStore(): CacheStore | null {
  if (resolvedStore === undefined) resolvedStore = createIndexedDbStore();
  return resolvedStore;
}

/**
 * テスト用のストア差し替え。null を渡すと「IndexedDB が使えない環境」を再現する。
 *
 * モジュール変数（閲覧者ヒント・書き込み時刻・バイパス）もあわせて初期化するので、
 * テストごとにこれを呼べば独立した状態から始められる。永続化の読み込みフラグも
 * 戻すため、localStorage を差し込んだテストでは「リロード直後」を再現できる。
 */
export function setCacheStoreForTests(next: CacheStore | null): void {
  resolvedStore = next;
  lastViewer = GUEST_OWNER;
  lastViewerAt = 0;
  lastMutationAt = 0;
  bypassKeys.clear();
}

/**
 * 最後に観測した閲覧者 ID。ルートはこれを {@link readCachedView} の owner に渡す。
 *
 * ヒントがずれていても、レコード側の owner 比較が最終防衛線として働くので情報は漏れない
 * （他人のレコードは読まれる前に捨てられ、サーバーへ取りに行く）。
 */
export function viewerHint(): string {
  syncPersistedState();
  return lastViewer;
}

/**
 * 直近の書き込み操作の時刻を記録する。
 *
 * これ以前に保存されたキャッシュは投稿・いいね・ログインの結果を反映していないので使わない。
 * これが無いと「投稿したのに 30 秒間タイムラインに出ない」不具合になる。
 */
export function noteMutation(at: number = Date.now()): void {
  lastMutationAt = Math.max(lastMutationAt, at);
  persistState();
}

/**
 * 送信状態の遷移が「送信の立ち上がり」かどうかを判定する（`app/root.tsx` が使う）。
 *
 * 記録してよいのは idle → pending の瞬間**だけ**。pending → idle（＝送信の完了）でも
 * {@link noteMutation} を呼ぶと、その完了に続く再検証が保存した**新しい**キャッシュの
 * 保存時刻が記録時刻より古くなり、次のナビゲーションで捨てられる。送信のたびに
 * 「必ず1回はサーバーへ行く」無駄が積み上がる（キャッシュが効くのは無送信の閲覧だけになる）。
 */
export function isMutationStart(previousPending: boolean, pending: boolean): boolean {
  return pending && !previousPending;
}

/**
 * キャッシュを読む。使えない・所有者違い・期限切れ・書き込みより古いレコードは null。
 */
export async function readCachedView<T>(key: string, owner: string): Promise<{ payload: T; savedAt: number } | null> {
  const active = activeStore();
  if (!active) return null;
  syncPersistedState();
  try {
    const record = await active.get(key);
    if (!record) return null;
    // 別の閲覧者のレコードは読まずに捨てる（他ユーザーデータの混入防止）。
    if (record.owner !== owner) {
      await active.delete(key);
      return null;
    }
    if (Date.now() - record.savedAt > CACHE_MAX_AGE_MS) {
      await active.delete(key);
      return null;
    }
    // 書き込みより古い表示は正しくないので捨てる。時刻はミリ秒精度しか無いので、
    // 同時刻（＝書き込みと同じミリ秒に保存されたレコード）も安全側に倒して捨てる。
    if (record.savedAt <= lastMutationAt) {
      await active.delete(key);
      return null;
    }
    return { payload: record.payload as T, savedAt: record.savedAt };
  } catch (error) {
    console.warn("client cache: read failed", error);
    return null;
  }
}

/**
 * キャッシュへ書く。失敗しても例外を投げない。
 *
 * @param fetchStartedAt - この payload を取りに行き始めた時刻。書き込み操作より前に
 *   始まった取得は、応答が届いたのが後でも古い内容なので保存しない。
 *   （dev のタイムライン自動更新のように、裏で走る取得が投稿を追い越す事故を防ぐ。）
 */
export async function writeCachedView(
  key: string,
  owner: string,
  payload: unknown,
  fetchStartedAt: number = Date.now(),
): Promise<void> {
  syncPersistedState();
  lastViewer = owner;
  lastViewerAt = Date.now();
  persistState();
  // 時刻はミリ秒精度しか無いので、書き込みと同じミリ秒に始まった取得も
  // 安全側に倒して保存しない（書き込み前の応答を新鮮扱いしないため）。
  if (fetchStartedAt <= lastMutationAt) return;
  const active = activeStore();
  if (!active) return;
  try {
    await active.put({ key, owner, savedAt: Date.now(), payload });
  } catch (error) {
    console.warn("client cache: write failed", error);
  }
}

/**
 * 全消去。ログアウト時に呼ぶ。
 *
 * 消去の完了を待たずに画面遷移が進んでも困らないよう、書き込み時刻も同時に更新して
 * 「これまでのレコードは無効」を即座に成立させる。
 */
export async function clearCache(): Promise<void> {
  syncPersistedState();
  lastViewer = GUEST_OWNER;
  lastViewerAt = Date.now();
  noteMutation();
  const active = activeStore();
  if (!active) return;
  try {
    await active.clear();
  } catch (error) {
    console.warn("client cache: clear failed", error);
  }
}

/**
 * 鮮度ウィンドウを適用して「再検証そのものを省く」ことが許されるかを判定する。
 *
 * **ログイン中の閲覧者には許さない。** 省略するとサーバーへ 1 度も行かないため、
 * 他端末でのパスワード変更（`changePassword` は他セッションを失効させる）や
 * セッションの期限切れが起きても、この端末はそれを検知できない。認証が要る
 * 一覧（ブックマークなど）を、ログインし直すべき状態のまま出し続けてしまう。
 *
 * 未ログインのレコードは公開ページの内容なので、従来どおり鮮度ウィンドウを使う。
 * ログイン中は「キャッシュを即時表示 → 直後に必ず再検証」（stale-while-revalidate）
 * になり、表示の速さは保ったまま、失効は次の遷移で必ず反映される。
 */
export function canSkipRevalidation(owner: string, savedAt: number, now: number = Date.now()): boolean {
  if (owner !== GUEST_OWNER) return false;
  return now - savedAt < CACHE_FRESH_MS;
}

/** 次回この key を読むときはキャッシュを無視してネットワークへ行く。 */
export function markBypass(key: string): void {
  bypassKeys.add(key);
}

/** バイパス指定を消費する。指定されていれば true。 */
export function consumeBypass(key: string): boolean {
  return bypassKeys.delete(key);
}
