import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_DB_NAME,
  CACHE_DB_VERSION,
  CACHE_MAX_AGE_MS,
  CACHE_STORE_NAME,
  cacheKeys,
  canSkipRevalidation,
  CACHE_FRESH_MS,
  clearCache,
  consumeBypass,
  createIndexedDbStore,
  GUEST_OWNER,
  isMutationStart,
  markBypass,
  noteMutation,
  readCachedView,
  setCacheStoreForTests,
  viewerHint,
  writeCachedView,
  type CachedRecord,
  type CacheStore,
} from "./client-cache";

/** メモリ上の CacheStore。中身を直接いじれるので保存時刻の細工がしやすい。 */
function createMemoryStore() {
  const records = new Map<string, CachedRecord>();
  const store: CacheStore & { records: Map<string, CachedRecord> } = {
    records,
    get: (key) => Promise.resolve(records.get(key)),
    put: (record) => {
      records.set(record.key, record);
      return Promise.resolve();
    },
    delete: (key) => {
      records.delete(key);
      return Promise.resolve();
    },
    clear: () => {
      records.clear();
      return Promise.resolve();
    },
  };
  return store;
}

function seed(store: ReturnType<typeof createMemoryStore>, record: Partial<CachedRecord> & { key: string }) {
  store.records.set(record.key, {
    owner: "user_1",
    savedAt: Date.now(),
    payload: { hello: "world" },
    ...record,
  });
}

afterEach(() => {
  setCacheStoreForTests(null);
  vi.restoreAllMocks();
});

describe("cacheKeys", () => {
  it("一覧ごとに衝突しないキーを組み立てる", () => {
    expect(cacheKeys.timeline("recommended")).toBe("timeline:recommended");
    expect(cacheKeys.timeline("following")).toBe("timeline:following");
    expect(cacheKeys.bookmarks(1)).toBe("bookmarks:1");
    expect(cacheKeys.bookmarks(1)).not.toBe(cacheKeys.bookmarks(2));
    // ハンドルの大文字小文字はキーを分けない（URL の揺れでキャッシュを二重に持たない）。
    expect(cacheKeys.profile("Demo_Aoi", 2)).toBe("profile:demo_aoi:2");
    expect(cacheKeys.profile("demo_aoi", 1)).not.toBe(cacheKeys.profile("demo_aoi", 2));
    // フォロー一覧もハンドルを小文字化し、種別とページで分ける。
    expect(cacheKeys.followList("Demo_Aoi", "followers", 1)).toBe("follows:demo_aoi:followers:1");
    expect(cacheKeys.followList("demo_aoi", "followers", 1)).not.toBe(cacheKeys.followList("demo_aoi", "following", 1));
    expect(cacheKeys.followList("demo_aoi", "following", 1)).not.toBe(cacheKeys.followList("demo_aoi", "following", 2));
  });
});

describe("readCachedView / writeCachedView", () => {
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(() => {
    store = createMemoryStore();
    setCacheStoreForTests(store);
  });

  it("保存した直後のレコードを読み戻せる", async () => {
    await writeCachedView("timeline:recommended", "user_1", { posts: [1, 2] });

    const cached = await readCachedView<{ posts: number[] }>("timeline:recommended", "user_1");
    expect(cached?.payload).toEqual({ posts: [1, 2] });
    expect(cached?.savedAt).toBeGreaterThan(0);
  });

  it("保存していないキーは null", async () => {
    expect(await readCachedView("bookmarks", "user_1")).toBeNull();
  });

  it("所有者が違うレコードは読まずに削除する", async () => {
    seed(store, { key: "bookmarks", owner: "user_1" });

    expect(await readCachedView("bookmarks", "user_2")).toBeNull();
    // 他ユーザーのデータを端末に残さない。
    expect(store.records.has("bookmarks")).toBe(false);
  });

  it("未ログインとログイン中は別の所有者として扱う", async () => {
    seed(store, { key: "timeline:recommended", owner: GUEST_OWNER });

    expect(await readCachedView("timeline:recommended", "user_1")).toBeNull();
  });

  it("保持期限を過ぎたレコードは捨てる", async () => {
    seed(store, { key: "bookmarks", savedAt: Date.now() - CACHE_MAX_AGE_MS - 1 });

    expect(await readCachedView("bookmarks", "user_1")).toBeNull();
    expect(store.records.has("bookmarks")).toBe(false);
  });

  it("保持期限ちょうどのレコードはまだ使える", async () => {
    // seed と読み取りの間に1ミリ秒進むと「期限切れ」に転んでしまう境界値なので、時計を止める。
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    seed(store, { key: "bookmarks", savedAt: now - CACHE_MAX_AGE_MS });

    expect(await readCachedView("bookmarks", "user_1")).not.toBeNull();
  });

  it("書き込み操作より前に保存したレコードは捨てる", async () => {
    await writeCachedView("timeline:recommended", "user_1", { posts: [] });
    // 投稿・いいね・ログインなどの送信を検知した想定。
    noteMutation(Date.now() + 1_000);

    expect(await readCachedView("timeline:recommended", "user_1")).toBeNull();
    expect(store.records.has("timeline:recommended")).toBe(false);
  });

  it("書き込み操作より後に保存したレコードは使える", async () => {
    noteMutation(Date.now() - 1_000);
    await writeCachedView("timeline:recommended", "user_1", { posts: [1] });

    expect(await readCachedView("timeline:recommended", "user_1")).not.toBeNull();
  });

  it("noteMutation は時刻を巻き戻さない", async () => {
    noteMutation(Date.now() + 1_000);
    noteMutation(Date.now() - 10_000);
    await writeCachedView("timeline:recommended", "user_1", { posts: [] });

    expect(await readCachedView("timeline:recommended", "user_1")).toBeNull();
  });

  it("書き込み操作より前に始めた取得の結果は保存しない", async () => {
    // 裏で走っていた取得（開始 = 過去）が、いま起きた送信を追い越して古い内容を残さないこと。
    const startedAt = Date.now() - 5_000;
    noteMutation();

    await writeCachedView("timeline:recommended", "user_1", { posts: [] }, startedAt);

    expect(store.records.size).toBe(0);
  });

  it("書き込み操作より後に始めた取得の結果は保存する", async () => {
    noteMutation(Date.now() - 5_000);

    await writeCachedView("timeline:recommended", "user_1", { posts: [1] }, Date.now());

    expect(await readCachedView("timeline:recommended", "user_1")).not.toBeNull();
  });

  it("書き込みと同じミリ秒に保存されたレコードは安全側に倒して捨てる", async () => {
    // Date.now() はミリ秒精度しか無いので、同時刻は「書き込み前」かもしれない。
    const at = Date.now();
    seed(store, { key: "timeline:recommended", savedAt: at });
    noteMutation(at);

    expect(await readCachedView("timeline:recommended", "user_1")).toBeNull();
  });

  it("書き込みと同じミリ秒に始めた取得の結果は保存しない", async () => {
    const at = Date.now();
    noteMutation(at);

    await writeCachedView("timeline:recommended", "user_1", { posts: [] }, at);

    expect(store.records.size).toBe(0);
  });

  it("読み取りが失敗しても例外にせず null を返す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setCacheStoreForTests({ ...store, get: () => Promise.reject(new Error("boom")) });

    expect(await readCachedView("bookmarks", "user_1")).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("書き込みが失敗しても例外を投げない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setCacheStoreForTests({ ...store, put: () => Promise.reject(new Error("quota")) });

    await expect(writeCachedView("bookmarks", "user_1", {})).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe("isMutationStart", () => {
  it("送信の立ち上がりだけを true にする", () => {
    // 初回マウント（何も起きていない）と、送信中の再レンダリング。
    expect(isMutationStart(false, false)).toBe(false);
    expect(isMutationStart(true, true)).toBe(false);
    // 送信が始まった。
    expect(isMutationStart(false, true)).toBe(true);
    // 送信が終わった。ここで記録すると、直後の再検証が書いたキャッシュを殺す。
    expect(isMutationStart(true, false)).toBe(false);
  });

  it("action 完了後の再検証で書かれたキャッシュが、次回参照まで生き残る", async () => {
    const store = createMemoryStore();
    setCacheStoreForTests(store);
    const key = cacheKeys.timeline("recommended");
    // 同一ミリ秒の取得は安全側に倒して保存しない仕様なので、実際の流れどおり
    // 「送信 → （actionの往復を挟んで）再検証」の時間差を時計で再現する。
    const base = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);

    // 1. 送信の立ち上がり（idle → pending）で無効化を記録する。
    let pending = false;
    const observe = (next: boolean) => {
      if (isMutationStart(pending, next)) noteMutation();
      pending = next;
    };
    observe(true);

    // 2. action の完了に続く再検証。取得の開始も保存も、記録より後の時刻になる。
    clock.mockReturnValue(base + 5);
    const fetchStartedAt = Date.now();
    await writeCachedView(key, "user_1", { posts: [1] }, fetchStartedAt);

    // 3. 送信が idle へ戻る。ここで記録してしまうと 2 のレコードが捨てられる。
    observe(false);

    expect(await readCachedView(key, "user_1")).not.toBeNull();
  });
});

describe("viewerHint", () => {
  beforeEach(() => {
    setCacheStoreForTests(createMemoryStore());
  });

  it("初期値は guest で、保存のたびに最後の閲覧者へ更新される", async () => {
    expect(viewerHint()).toBe(GUEST_OWNER);

    await writeCachedView("timeline:recommended", "user_1", {});
    expect(viewerHint()).toBe("user_1");
  });

  it("ストアが無くてもヒントは更新される", async () => {
    setCacheStoreForTests(null);

    await writeCachedView("timeline:recommended", "user_9", {});
    expect(viewerHint()).toBe("user_9");
  });
});

describe("clearCache", () => {
  it("全レコードを消し、それ以前のレコードを無効にする", async () => {
    const store = createMemoryStore();
    setCacheStoreForTests(store);
    await writeCachedView("timeline:recommended", "user_1", { posts: [1] });

    await clearCache();

    expect(store.records.size).toBe(0);
    expect(viewerHint()).toBe(GUEST_OWNER);
    // 消去が非同期で遅れても、書き込み時刻の更新で古いレコードは使われない。
    seed(store, { key: "timeline:recommended", owner: "user_1", savedAt: Date.now() - 5_000 });
    expect(await readCachedView("timeline:recommended", "user_1")).toBeNull();
  });

  it("消去が失敗しても例外を投げない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setCacheStoreForTests({ ...createMemoryStore(), clear: () => Promise.reject(new Error("boom")) });

    await expect(clearCache()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe("markBypass / consumeBypass", () => {
  it("指定したキーを一度だけ素通しする", () => {
    setCacheStoreForTests(createMemoryStore());

    expect(consumeBypass("timeline:recommended")).toBe(false);
    markBypass("timeline:recommended");
    expect(consumeBypass("timeline:recommended")).toBe(true);
    expect(consumeBypass("timeline:recommended")).toBe(false);
    // 別のキーは影響を受けない。
    expect(consumeBypass("bookmarks")).toBe(false);
  });
});

describe("IndexedDB が使えない環境", () => {
  beforeEach(() => {
    setCacheStoreForTests(null);
  });

  it("createIndexedDbStore は null を返す（Node / SSR）", () => {
    expect(typeof indexedDB).toBe("undefined");
    expect(createIndexedDbStore()).toBeNull();
  });

  it("すべての API が例外なく素通しになる", async () => {
    await expect(writeCachedView("bookmarks", "user_1", {})).resolves.toBeUndefined();
    expect(await readCachedView("bookmarks", "user_1")).toBeNull();
    await expect(clearCache()).resolves.toBeUndefined();
    markBypass("bookmarks");
    expect(consumeBypass("bookmarks")).toBe(true);
  });
});

// --- ここから下は createIndexedDbStore 自体の検証（最小限のフェイク IndexedDB を使う） ---

type FakeStoreData = Map<string, unknown>;

class FakeRequest<T> {
  result: T | undefined;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(run: () => T) {
    queueMicrotask(() => {
      try {
        this.result = run();
      } catch {
        this.onerror?.();
        return;
      }
      this.onsuccess?.();
    });
  }
}

function fakeObjectStore(data: FakeStoreData) {
  return {
    get: (key: string) => new FakeRequest(() => data.get(key)),
    put: (record: CachedRecord) => new FakeRequest(() => data.set(record.key, record).size),
    delete: (key: string) => new FakeRequest(() => data.delete(key)),
    clear: () => new FakeRequest(() => data.clear()),
  };
}

class FakeDatabase {
  stores = new Map<string, FakeStoreData>();
  objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  createdCount = 0;
  deletedCount = 0;

  createObjectStore(name: string) {
    this.createdCount += 1;
    this.stores.set(name, new Map());
  }
  deleteObjectStore(name: string) {
    this.deletedCount += 1;
    this.stores.delete(name);
  }
  transaction(name: string) {
    const data = this.stores.get(name);
    if (!data) throw new Error(`unknown object store: ${name}`);
    return { objectStore: () => fakeObjectStore(data) };
  }
}

type OpenBehavior = "success" | "upgrade" | "error" | "blocked" | "throw";

/** 最小限の IDBFactory。open の結果だけを差し替えられるようにしてある。 */
function installFakeIndexedDb(behavior: OpenBehavior, db = new FakeDatabase()) {
  const opened: { name: string; version: number }[] = [];
  const factory = {
    open(name: string, version: number) {
      opened.push({ name, version });
      if (behavior === "throw") throw new Error("indexedDB is disabled");
      const request: {
        result: FakeDatabase;
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onblocked: (() => void) | null;
      } = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        if (behavior === "error") return request.onerror?.();
        if (behavior === "blocked") return request.onblocked?.();
        if (behavior === "upgrade") request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  const globalWithIdb = globalThis as { indexedDB?: IDBFactory };
  globalWithIdb.indexedDB = factory as unknown as IDBFactory;
  return { db, opened };
}

function uninstallFakeIndexedDb() {
  delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
}

describe("createIndexedDbStore", () => {
  afterEach(uninstallFakeIndexedDb);

  it("保存・取得・削除・全消去がひと通り動く", async () => {
    const { db, opened } = installFakeIndexedDb("upgrade");
    const store = createIndexedDbStore();
    expect(store).not.toBeNull();
    if (!store) return;

    const record: CachedRecord = { key: "bookmarks", owner: "user_1", savedAt: 123, payload: { posts: [] } };
    await store.put(record);
    expect(await store.get("bookmarks")).toEqual(record);
    expect(opened).toEqual([{ name: CACHE_DB_NAME, version: CACHE_DB_VERSION }]);

    await store.delete("bookmarks");
    expect(await store.get("bookmarks")).toBeUndefined();

    await store.put(record);
    await store.clear();
    expect(db.stores.get(CACHE_STORE_NAME)?.size).toBe(0);
    // 接続は使い回すので、open は最初の一度だけ。
    expect(opened).toHaveLength(1);
  });

  it("版を上げるとオブジェクトストアを作り直す", async () => {
    const db = new FakeDatabase();
    // 旧版のレコードが残っている状態。
    db.stores.set(CACHE_STORE_NAME, new Map([["bookmarks", { key: "bookmarks", owner: "u", savedAt: 1 }]]));
    installFakeIndexedDb("upgrade", db);

    const store = createIndexedDbStore();
    expect(await store?.get("bookmarks")).toBeUndefined();
    expect(db.deletedCount).toBe(1);
    expect(db.createdCount).toBe(1);
  });

  it("期待した形でないレコードは無視する", async () => {
    const db = new FakeDatabase();
    db.stores.set(CACHE_STORE_NAME, new Map([["bookmarks", { key: "bookmarks" }]]));
    installFakeIndexedDb("success", db);

    expect(await createIndexedDbStore()?.get("bookmarks")).toBeUndefined();
  });

  it("DB を開けないときは何もせず undefined を返す", async () => {
    installFakeIndexedDb("error");
    const store = createIndexedDbStore();

    expect(await store?.get("bookmarks")).toBeUndefined();
    await expect(store?.put({ key: "bookmarks", owner: "u", savedAt: 1, payload: null })).resolves.toBeUndefined();
    await expect(store?.clear()).resolves.toBeUndefined();
  });

  it("別タブに upgrade を邪魔されたときも落ちない", async () => {
    installFakeIndexedDb("blocked");

    expect(await createIndexedDbStore()?.get("bookmarks")).toBeUndefined();
  });

  it("open 自体が例外を投げても落ちない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installFakeIndexedDb("throw");

    expect(await createIndexedDbStore()?.get("bookmarks")).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("トランザクションが張れないときも落ちない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = new FakeDatabase();
    // onupgradeneeded を呼ばずにストアが無い DB を返す（＝ transaction が投げる）。
    installFakeIndexedDb("success", db);

    expect(await createIndexedDbStore()?.get("bookmarks")).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("状態の永続化（リロードまたぎ）", () => {
  /** メモリ実装の localStorage。テスト内でリロードをまたぐ持ち越しを再現する。 */
  function createFakeLocalStorage(): Storage {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
      clear: () => map.clear(),
      key: () => null,
      get length() {
        return map.size;
      },
    } as Storage;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("書き込み時刻がリロード後も残り、書き込み前のレコードを退ける", async () => {
    vi.stubGlobal("localStorage", createFakeLocalStorage());
    const store = createMemoryStore();
    setCacheStoreForTests(store);
    seed(store, { key: "bookmarks:1", savedAt: Date.now() - 1_000 });
    // ブックマーク解除などの送信を検知した想定。
    noteMutation();

    // リロード（モジュール状態の初期化）を再現する。IndexedDB 側の中身はそのまま。
    setCacheStoreForTests(store);

    // メモリだけの管理だとここで記録が消え、古いレコードが「新鮮」扱いに戻ってしまう。
    expect(await readCachedView("bookmarks:1", "user_1")).toBeNull();
  });

  it("閲覧者ヒントがリロード後も残り、guest のレコードを拾わない", async () => {
    vi.stubGlobal("localStorage", createFakeLocalStorage());
    const store = createMemoryStore();
    setCacheStoreForTests(store);
    // ログイン中の取得で閲覧者ヒントが user_9 になった想定。
    await writeCachedView(cacheKeys.profile("someone", 1), "user_9", { ok: true });
    // 未ログイン時代のレコードが残っていた想定。
    seed(store, { key: cacheKeys.timeline("recommended"), owner: GUEST_OWNER });

    setCacheStoreForTests(store);

    expect(viewerHint()).toBe("user_9");
    // ヒントが guest に戻っていると、この読み取りが guest のレコードを「新鮮」として返してしまう。
    expect(await readCachedView(cacheKeys.timeline("recommended"), viewerHint())).toBeNull();
  });

  it("clearCache は guest ヒントを永続化し、リロード後も引き継ぐ", async () => {
    vi.stubGlobal("localStorage", createFakeLocalStorage());
    const store = createMemoryStore();
    setCacheStoreForTests(store);
    await writeCachedView("bookmarks:1", "user_9", { posts: [] });

    await clearCache();
    setCacheStoreForTests(store);

    expect(viewerHint()).toBe(GUEST_OWNER);
  });

  it("localStorage が無い環境（SSR・Node）では従来どおり動く", async () => {
    const store = createMemoryStore();
    setCacheStoreForTests(store);

    await writeCachedView("bookmarks:1", "user_1", { posts: [] });

    expect(await readCachedView("bookmarks:1", "user_1")).not.toBeNull();
  });

  it("開きっぱなしのタブでも、別タブの書き込み記録を読むたびに合流する", async () => {
    const fake = createFakeLocalStorage();
    vi.stubGlobal("localStorage", fake);
    const store = createMemoryStore();
    setCacheStoreForTests(store);
    // このタブは一度読み込みを済ませている（＝一度きりの読み込みでは以後を見ない状態）。
    expect(viewerHint()).toBe(GUEST_OWNER);
    seed(store, { key: "bookmarks:1", savedAt: Date.now() });

    // 別タブが投稿を検知して、より新しい無効化時刻を書き込んだ想定。
    fake.setItem(
      "commons-sns-view-cache-state",
      JSON.stringify({ viewer: "user_1", viewerAt: Date.now(), mutationAt: Date.now() + 5 }),
    );

    expect(await readCachedView("bookmarks:1", "user_1")).toBeNull();
  });

  it("古いタブの保存が、別タブの新しい記録を巻き戻さない", async () => {
    const fake = createFakeLocalStorage();
    vi.stubGlobal("localStorage", fake);
    const store = createMemoryStore();
    setCacheStoreForTests(store);
    const base = Date.now();
    noteMutation(base - 60_000);

    // 別タブがより新しい無効化時刻を書き込んだ想定。
    fake.setItem(
      "commons-sns-view-cache-state",
      JSON.stringify({ viewer: "user_1", viewerAt: base, mutationAt: base + 60_000 }),
    );

    // このタブの保存（writeCachedView 経由）が単純上書きだと base - 60_000 に巻き戻る。
    await writeCachedView("bookmarks:1", "user_1", { posts: [] });

    const stored = JSON.parse(fake.getItem("commons-sns-view-cache-state") ?? "{}") as { mutationAt?: number };
    expect(stored.mutationAt).toBe(base + 60_000);
    // 合流した記録はこのタブにも反映され、それより古いレコードは使われない。
    seed(store, { key: "timeline:recommended", savedAt: base + 30_000 });
    expect(await readCachedView("timeline:recommended", "user_1")).toBeNull();
  });

  it("壊れた永続値は無視して既定値から始める", () => {
    const fake = createFakeLocalStorage();
    fake.setItem("commons-sns-view-cache-state", "{not json");
    vi.stubGlobal("localStorage", fake);
    setCacheStoreForTests(createMemoryStore());

    expect(viewerHint()).toBe(GUEST_OWNER);
  });
});

describe("canSkipRevalidation", () => {
  it("未ログインの記録は鮮度ウィンドウ内なら再検証を省ける", () => {
    const now = Date.now();
    expect(canSkipRevalidation(GUEST_OWNER, now, now)).toBe(true);
    expect(canSkipRevalidation(GUEST_OWNER, now - CACHE_FRESH_MS + 1, now)).toBe(true);
  });

  it("鮮度ウィンドウを過ぎたら未ログインでも再検証する", () => {
    const now = Date.now();
    expect(canSkipRevalidation(GUEST_OWNER, now - CACHE_FRESH_MS, now)).toBe(false);
  });

  it("ログイン中は鮮度ウィンドウ内でも必ず再検証する", () => {
    // 省略するとサーバーへ一度も行かないため、他端末でのパスワード変更などで
    // セッションが失効しても検知できず、認証が要る一覧を出し続けてしまう。
    const now = Date.now();
    expect(canSkipRevalidation("user_1", now, now)).toBe(false);
    expect(canSkipRevalidation("user_1", now - 1, now)).toBe(false);
  });
});
