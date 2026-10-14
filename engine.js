// 网站数据处理页：负责"假访问"每个网站，读出/写回它的本地存储和 IndexedDB。
// 全程不发网络请求：导航在发出前就被拦截，由本地假页面顶上，浏览器只认页面地址属于哪个网站。

const CDP = "1.3";
const FAKE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Cookie Transfer</title></head><body></body></html>';
const FEED_SIZE = 1024 * 1024;
const WORKER_MIN = 1;
const WORKER_MAX = 100;
const WORKER_DEFAULT = 3;
const NAV_TIMEOUT = 20000;
const DUMP_TIMEOUT = 300000;
const FAILURE_LIMIT = 200;
const FORMAT = "cookie-transfer-sitedata-v2";

// 只能对普通网站动手脚，浏览器自己的页面、扩展页面都排除
const SKIP_HOSTS = new Set(["chromewebstore.google.com", "addons.microsoft.com"]);

const tabsById = new Map();
let engineWindowId = null;
let busy = false;
let incoming = { chunks: [] };

// ---------- 与调试能力打交道的工作标签页 ----------

class WorkerTab {
  constructor(tabId) {
    this.tabId = tabId;
    this.ctx = null;
    this.origin = null;
    this.onReady = null;
  }

  static async create(windowId) {
    const tab = await chrome.tabs.create({ url: "about:blank", active: false, windowId });
    const w = new WorkerTab(tab.id);
    tabsById.set(tab.id, w);
    await w.start();
    return w;
  }

  cmd(method, params) {
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params || {});
  }

  async start() {
    await chrome.debugger.attach({ tabId: this.tabId }, CDP);
    await this.cmd("Page.enable");
    await this.cmd("Runtime.enable");
    await this.cmd("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
  }

  async stop() {
    tabsById.delete(this.tabId);
    try {
      await chrome.debugger.detach({ tabId: this.tabId });
    } catch {}
    try {
      await chrome.tabs.remove(this.tabId);
    } catch {}
  }

  // 让浏览器"进入"某个网站的页面：地址是它的，内容是假的。
  // 返回文档真正落在哪个地址上（新旧地址可能被浏览器改写），不用再额外问一次。
  async goto(origin) {
    this.ctx = null;
    this.origin = null;
    const committed = new Promise((resolve, reject) => {
      this.onReady = resolve;
      this.onFail = reject;
      setTimeout(() => reject(new Error("打开网站外壳超时")), NAV_TIMEOUT);
    });
    const nav = await this.cmd("Page.navigate", { url: origin + "/" });
    if (nav && nav.errorText) {
      throw new Error("导航失败：" + nav.errorText);
    }
    await committed;
    this.onReady = null;
    return this.origin;
  }

  async evaluate(expression, { awaitPromise = false, timeout = 0 } = {}) {
    const run = this.cmd("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      contextId: this.ctx || undefined,
    }).then((res) => {
      if (res.exceptionDetails) {
        throw new Error(
          "页面内执行出错：" +
            (res.exceptionDetails.exception?.description || res.exceptionDetails.text)
        );
      }
      return res.result.value;
    });
    if (!timeout) return run;
    return Promise.race([
      run,
      new Promise((_r, rej) => setTimeout(() => rej(new Error("页面内执行超时")), timeout)),
    ]);
  }

  handleEvent(method, params) {
    if (method === "Runtime.executionContextCreated") {
      const c = params.context;
      // 只认普通网站地址的文档；about:blank 之类不算"进到了网站里"。
      // 记下文档真正落在哪个地址，浏览器可能把 http 改写成一个不存在的 https 子域。
      if (this.onReady && /^https?:/.test(c.origin)) {
        this.ctx = c.id;
        this.origin = c.origin;
        const resolve = this.onReady;
        this.onReady = null;
        resolve();
      }
    } else if (method === "Runtime.executionContextDestroyed") {
      if (params.executionContextId === this.ctx) this.ctx = null;
    } else if (method === "Fetch.requestPaused") {
      this.answerFake(params.requestId);
    }
  }

  async answerFake(requestId) {
    try {
      await this.cmd("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
        body: stringToB64(FAKE_HTML),
      });
    } catch {}
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const w = tabsById.get(source.tabId);
  if (w) w.handleEvent(method, params);
});

chrome.debugger.onDetach.addListener((source) => {
  const w = tabsById.get(source.tabId);
  if (w) {
    tabsById.delete(w.tabId);
    if (w.onFail) w.onFail(new Error("调试连接被断开"));
  }
});

function stringToB64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- 要处理哪些网站 ----------

function originOf(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (SKIP_HOSTS.has(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

// 从 Cookie 里只能拿到域名，猜不到用哪个协议，所以 https 和 http 都试
function originsFromDomain(domain) {
  const host = domain.replace(/^\./, "");
  if (!host) return [];
  return [`https://${host}`, `http://${host}`];
}

async function buildOriginList({ useBrowserList, manualText }) {
  const list = [];
  const seen = new Set();

  const push = (origin) => {
    if (origin && !seen.has(origin)) {
      seen.add(origin);
      list.push(origin);
    }
  };

  for (const line of (manualText || "").split(/[\s,;]+/)) {
    if (!line) continue;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(line) ? line : "https://" + line;
    push(originOf(withScheme));
  }

  if (useBrowserList) {
    const openTabs = await chrome.tabs.query({});
    for (const t of openTabs) push(originOf(t.url));

    const cookies = await chrome.cookies.getAll({});
    for (const c of cookies) for (const o of originsFromDomain(c.domain || "")) push(o);

    const visits = await chrome.history.search({ text: "", startTime: 0, maxResults: 0 });
    for (const v of visits) push(originOf(v.url));
  }

  return list;
}

// ---------- 在页面里跑的两个大函数（会被转成文字送进页面，所以不能引用外面任何东西）----------

async function pageDump() {
  const CH = 0x8000;
  let blobBytes = 0;

  function bufToB64(buf) {
    const u = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < u.length; i += CH) bin += String.fromCharCode.apply(null, u.subarray(i, i + CH));
    return btoa(bin);
  }

  function txdone(tx) {
    return new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onabort = () => rej(tx.error || new Error("事务被中止"));
      tx.onerror = () => rej(tx.error || new Error("事务出错"));
    });
  }

  function openDb(name, version) {
    return new Promise((res, rej) => {
      const r = version == null ? indexedDB.open(name) : indexedDB.open(name, version);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error("打不开数据库"));
      r.onblocked = () => rej(new Error("被其他页面占用"));
    });
  }

  async function enc(v, seen) {
    if (v === null) return null;
    const t = typeof v;
    if (t === "string" || t === "boolean") return v;
    if (t === "number") return Number.isFinite(v) ? v : { __: "num", v: String(v) };
    if (t === "undefined") return { __: "und" };
    if (t === "bigint") return { __: "bi", v: String(v) };
    if (t === "function" || t === "symbol") return { __: "skip" };

    if (typeof File !== "undefined" && v instanceof File) {
      blobBytes += v.size;
      return { __: "file", name: v.name, type: v.type, lastModified: v.lastModified, size: v.size, data: bufToB64(await v.arrayBuffer()) };
    }
    if (typeof Blob !== "undefined" && v instanceof Blob) {
      blobBytes += v.size;
      return { __: "blob", type: v.type, size: v.size, data: bufToB64(await v.arrayBuffer()) };
    }
    if (v instanceof Date) return { __: "date", v: Number.isNaN(v.getTime()) ? null : v.getTime() };
    if (v instanceof RegExp) return { __: "re", s: v.source, f: v.flags };
    if (v instanceof ArrayBuffer) return { __: "ab", data: bufToB64(v) };
    if (ArrayBuffer.isView(v)) {
      if (v instanceof DataView) return { __: "dv", o: v.byteOffset, l: v.byteLength, data: bufToB64(v.buffer) };
      return { __: "tv", c: v.constructor.name, o: v.byteOffset, l: v.length, data: bufToB64(v.buffer) };
    }
    if (typeof IDBKeyRange !== "undefined" && v instanceof IDBKeyRange) {
      return { __: "kr", lo: v.lower, up: v.upper, lb: v.lowerOpen, ub: v.upperOpen };
    }
    if (seen.has(v)) return { __: "cyc" };
    seen.add(v);

    let out;
    if (v instanceof Map) {
      const e = [];
      for (const [k, x] of v) e.push([await enc(k, seen), await enc(x, seen)]);
      out = { __: "map", e };
    } else if (v instanceof Set) {
      const e = [];
      for (const x of v) e.push(await enc(x, seen));
      out = { __: "set", e };
    } else if (Array.isArray(v)) {
      const e = [];
      for (let i = 0; i < v.length; i++) e.push(i in v ? await enc(v[i], seen) : { __: "hole" });
      out = { __: "arr", l: v.length, e };
    } else {
      const e = [];
      for (const [k, x] of Object.entries(v)) e.push([k, await enc(x, seen)]);
      out = { __: "obj", e };
    }
    seen.delete(v);
    return out;
  }

  const meta = { origin: location.origin, localStorage: 0, databases: 0, records: 0, blobBytes: 0, notes: [] };
  const entry = { origin: location.origin, localStorage: [], indexedDB: [] };

  for (const [k, v] of Object.entries(localStorage)) entry.localStorage.push([k, v]);
  meta.localStorage = entry.localStorage.length;

  let dbs = [];
  try {
    dbs = await indexedDB.databases();
  } catch (e) {
    meta.notes.push("这个网站的数据库清单读不了（普通网站才有）：" + e.message);
  }

  for (const info of dbs) {
    let db;
    try {
      db = await openDb(info.name);
      const stores = [];
      for (const storeName of Array.from(db.objectStoreNames)) {
        const raw = [];
        const tx = db.transaction(storeName, "readonly");
        const st = tx.objectStore(storeName);
        const indexNames = Array.from(st.indexNames);
        const indexes = indexNames.map((n) => {
          const ix = st.index(n);
          return { name: n, keyPath: ix.keyPath, unique: ix.unique, multi: ix.multiEntry };
        });
        const rows = await new Promise((res, rej) => {
          const out = [];
          const cursorReq = st.openCursor();
          cursorReq.onsuccess = () => {
            const c = cursorReq.result;
            if (!c) return res(out);
            out.push({ key: c.key, value: c.value });
            c.continue();
          };
          cursorReq.onerror = () => rej(cursorReq.error);
        });
        await txdone(tx);

        const recs = [];
        for (const r of rows) {
          const value = await enc(r.value, new Set());
          const key = await enc(r.key, new Set());
          recs.push({ key, value });
        }
        meta.records += recs.length;
        stores.push({
          name: storeName,
          keyPath: st.keyPath,
          auto: st.autoIncrement,
          indexes,
          recs,
        });
      }
      entry.indexedDB.push({ name: info.name, version: info.version, stores });
      meta.databases += 1;
    } catch (e) {
      meta.notes.push("数据库 " + info.name + " 读不了：" + e.message);
    } finally {
      if (db) db.close();
    }
  }

  const text = JSON.stringify(entry);
  const PART = 1024 * 1024;
  const parts = [];
  for (let i = 0; i < text.length; i += PART) parts.push(text.slice(i, i + PART));
  window.__CT_PARTS = parts;
  meta.bytes = text.length;
  meta.blobBytes = blobBytes;
  meta.partCount = parts.length;
  return meta;
}

async function pageRestore() {
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function txdone(tx) {
    return new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onabort = () => rej(tx.error || new Error("事务被中止"));
      tx.onerror = () => rej(tx.error || new Error("事务出错"));
    });
  }

  function del(name) {
    return new Promise((res, rej) => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error || new Error("删不掉旧数据库"));
      r.onblocked = () => rej(new Error("被其他页面占用"));
    });
  }

  function rebuild(d) {
    if (d === null || typeof d !== "object") return d;
    if (!d.__) {
      if (Array.isArray(d)) return d.map(rebuild);
      const o = {};
      for (const [k, v] of Object.entries(d)) o[k] = rebuild(v);
      return o;
    }
    switch (d.__) {
      case "num":
        return d.v === "NaN" ? NaN : d.v === "Infinity" ? Infinity : -Infinity;
      case "und":
      case "skip":
      case "cyc":
      case "hole":
        return undefined;
      case "bi":
        return BigInt(d.v);
      case "date":
        return d.v === null ? new Date(NaN) : new Date(d.v);
      case "re":
        return new RegExp(d.s, d.f);
      case "blob":
        return new Blob([b64ToBuf(d.data)], { type: d.type || "" });
      case "file":
        return new File([b64ToBuf(d.data)], d.name || "blob", { type: d.type || "", lastModified: d.lastModified || 0 });
      case "ab":
        return b64ToBuf(d.data);
      case "dv":
        return new DataView(b64ToBuf(d.data), d.o, d.l);
      case "tv": {
        const buf = b64ToBuf(d.data);
        const Ctor = self[d.c];
        return Ctor ? new Ctor(buf, d.o, d.l) : new Uint8Array(buf);
      }
      case "kr":
        if (d.lb && d.ub) return IDBKeyRange.bound(d.lo, d.up, true, true);
        if (d.lb) return IDBKeyRange.lowerBound(d.lo, true);
        if (d.ub) return IDBKeyRange.upperBound(d.up, true);
        return d.lo === d.up ? IDBKeyRange.only(d.lo) : IDBKeyRange.bound(d.lo, d.up);
      case "map": {
        const m = new Map();
        for (const [k, v] of d.e) m.set(rebuild(k), rebuild(v));
        return m;
      }
      case "set": {
        const s = new Set();
        for (const v of d.e) s.add(rebuild(v));
        return s;
      }
      case "arr": {
        const a = new Array(d.l);
        for (let i = 0; i < d.e.length; i++) a[i] = rebuild(d.e[i]);
        return a;
      }
      case "obj": {
        const o = {};
        for (const [k, v] of d.e) o[k] = rebuild(v);
        return o;
      }
      default:
        return d;
    }
  }

  const entry = JSON.parse(window.__CT_ACC);

  const result = { localStorage: 0, databases: 0, records: 0, notes: [] };

  for (const [k, v] of entry.localStorage || []) {
    localStorage.setItem(k, v);
    result.localStorage += 1;
  }

  for (const d of entry.indexedDB || []) {
    try {
      await del(d.name);
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(d.name, d.version);
        r.onupgradeneeded = () => {
          const cur = r.result;
          const tx = r.transaction;
          for (const s of d.stores) {
            const st = cur.createObjectStore(s.name, { keyPath: s.keyPath || undefined, autoIncrement: !!s.auto });
            for (const ix of s.indexes || []) st.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multi });
          }
          tx.oncomplete = () => res(cur);
          tx.onabort = () => rej(tx.error || new Error("建表失败"));
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error || new Error("打不开数据库"));
        r.onblocked = () => rej(new Error("被其他页面占用"));
      });

      for (const s of d.stores) {
        const inLine = !!s.keyPath;
        for (let start = 0; start < s.recs.length; start += 500) {
          const batch = s.recs.slice(start, start + 500);
          const tx = db.transaction(s.name, "readwrite");
          const st = tx.objectStore(s.name);
          for (const rec of batch) {
            const value = rebuild(rec.value);
            const key = rebuild(rec.key);
            if (inLine || key === undefined) st.put(value);
            else st.put(value, key);
          }
          await txdone(tx);
          result.records += batch.length;
        }
      }
      db.close();
      result.databases += 1;
    } catch (e) {
      result.notes.push("数据库 " + d.name + " 写不进去：" + e.message);
    }
  }

  return result;
}

// ---------- 工作标签池 ----------

// 后台页面按需开：设成 100 但只有 3 个网站时，就只开 3 个
class Pool {
  constructor(limit) {
    this.limit = limit;
    this.created = 0;
    this.free = [];
    this.waiters = [];
    this.all = [];
  }

  async acquire() {
    if (this.free.length) return this.free.pop();
    if (this.created < this.limit) {
      this.created++;
      const w = await WorkerTab.create(engineWindowId);
      this.all.push(w);
      return w;
    }
    return new Promise((res) => this.waiters.push(res));
  }

  release(w) {
    const next = this.waiters.shift();
    if (next) next(w);
    else this.free.push(w);
  }

  async close() {
    for (const w of this.all) await w.stop();
    this.all = [];
    this.free = [];
    this.created = 0;
  }
}

// 并发数由用户在界面上调，导出和导入都从这里取
async function makePool() {
  const { concurrency } = await chrome.storage.local.get("concurrency");
  const n = Math.floor(Number(concurrency));
  const wanted = Number.isFinite(n) ? Math.min(WORKER_MAX, Math.max(WORKER_MIN, n)) : WORKER_DEFAULT;
  return new Pool(wanted);
}

async function drain(pool, jobs, runners) {
  const list = [];
  for (let i = 0; i < runners; i++) list.push(jobs(pool));
  await Promise.all(list);
}

// 失败条数只留前若干条详情，几万条全失败时不该把备份文件撑爆
function makeFailureRecorder(limit) {
  const list = [];
  let count = 0;
  return {
    list,
    get count() {
      return count;
    },
    add(text) {
      count++;
      if (list.length < limit) list.push(text);
    },
  };
}

// ---------- 导出 ----------

async function runExport(payload) {
  const origins = await buildOriginList(payload || {});
  if (!origins.length) {
    post({ type: "siteData:done", ok: false, error: "没有任何要处理的网站，请勾选自动收集或填写网址" });
    return;
  }

  const captured = new Set();
  const bodies = []; // 每个有数据的网站一段文字，最后一次性拼成文件
  const failure = makeFailureRecorder(FAILURE_LIMIT);
  const stats = { sites: 0, localStorageKeys: 0, databases: 0, records: 0, blobBytes: 0, bytes: 0 };
  let scanned = 0;
  let done = 0;
  const total = origins.length;
  const report = (current) => post({ type: "siteData:progress", phase: "export", done, total, current });

  const pool = await makePool();
  let cursor = 0;

  const jobs = async (pool) => {
    const w = await pool.acquire();
    try {
      while (cursor < origins.length) {
        const origin = origins[cursor++];
        if (captured.has(origin)) {
          done++;
          continue;
        }
        report(origin);
        try {
          const actual = await w.goto(origin);
          if (captured.has(actual)) continue;
          captured.add(actual);
          scanned++;

          const meta = await w.evaluate(`(${pageDump.toString()})()`, { awaitPromise: true, timeout: DUMP_TIMEOUT });
          for (const n of meta.notes || []) failure.add(actual + "：" + n);

          if (meta.localStorage + meta.databases === 0) continue;

          // 先整段收齐再交出去，否则几个网站同时写会互相穿插
          const pieces = [];
          for (let i = 0; i < meta.partCount; i++) pieces.push(await w.evaluate(`window.__CT_PARTS[${i}]`));
          bodies.push(pieces);

          stats.sites += 1;
          stats.localStorageKeys += meta.localStorage;
          stats.databases += meta.databases;
          stats.records += meta.records;
          stats.blobBytes += meta.blobBytes;
          stats.bytes += meta.bytes;
        } catch (e) {
          failure.add(origin + "：" + (e.message || String(e)));
        } finally {
          done++;
        }
      }
    } finally {
      pool.release(w);
    }
  };

  try {
    await drain(pool, jobs, Math.min(pool.limit, origins.length));
  } finally {
    await pool.close();
  }

  // 一个网站一行，导入时才能一行一行读，不必把整个文件一次吞进内存
  const header = `{"format":${JSON.stringify(FORMAT)},"exportedAt":${JSON.stringify(new Date().toISOString())},` +
    `"scanned":${scanned},"siteCount":${bodies.length},"failures":${JSON.stringify(failure.list)},` +
    `"failureCount":${failure.count},"stats":${JSON.stringify(stats)},"origins":[`;

  const parts = [header + "\n"];
  for (let i = 0; i < bodies.length; i++) {
    if (i) parts.push(",\n");
    for (const p of bodies[i]) parts.push(p);
  }
  parts.push("\n]}");

  const blob = new Blob(parts, { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const filename = `site-data-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

  post({ type: "siteData:done", ok: true, phase: "export", scanned, ...stats, failureCount: failure.count, filename });

  await downloadAndRelease(url, filename);
}

// ---------- 导入 ----------

// 逐行读备份：头一行拿总数，之后每行一个网站，读一个处理一个，读完就把用过的字节丢掉
function makeLineReader(onLine) {
  let rest = "";
  return {
    push(text) {
      rest += text;
      let nl;
      while ((nl = rest.indexOf("\n")) >= 0) {
        const line = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        onLine(line);
      }
    },
    // 最后一行可能没有换行符收尾
    end() {
      if (rest) {
        onLine(rest);
        rest = "";
      }
    },
  };
}

async function runImport() {
  const pool = await makePool();
  const failure = makeFailureRecorder(FAILURE_LIMIT);
  const stats = { sites: 0, localStorageKeys: 0, databases: 0, records: 0 };
  let total = 0;
  let done = 0;
  let badFormat = null;
  let inOrigins = false;

  const inflight = new Set();

  const importOne = async (line) => {
    const w = await pool.acquire();
    try {
      const entry = JSON.parse(line.replace(/,$/, ""));
      if (!entry || typeof entry.origin !== "string" || !/^https?:/.test(entry.origin)) {
        failure.add("备份里有一条记录的网站地址不对，跳过了：" + String(entry && entry.origin).slice(0, 80));
        return;
      }
      post({ type: "siteData:progress", phase: "import", done, total, current: entry.origin });

      await w.goto(entry.origin);
      const text = JSON.stringify(entry);
      // 第一段直接赋值，后面再往后接，省一次来回
      for (let i = 0, n = 0; i < text.length; i += FEED_SIZE, n++) {
        await w.evaluate(
          (n ? "__CT_ACC += " : "window.__CT_ACC = ") + JSON.stringify(text.slice(i, i + FEED_SIZE))
        );
      }
      const r = await w.evaluate(`(${pageRestore.toString()})()`, { awaitPromise: true });
      stats.sites += 1;
      stats.localStorageKeys += r.localStorage;
      stats.databases += r.databases;
      stats.records += r.records;
      for (const n of r.notes || []) failure.add(entry.origin + "：" + n);
    } catch (e) {
      failure.add(line.slice(0, 60) + "……：" + (e.message || String(e)));
    } finally {
      done++;
      pool.release(w);
    }
  };

  const reader = makeLineReader((line) => {
    const s = line.trim();
    if (!s || badFormat) return;

    if (!inOrigins) {
      const f = /"format":"([^"]+)"/.exec(s);
      if (f && f[1] !== FORMAT) {
        badFormat = s.includes('"origins"')
          ? "这是旧版插件导出的文件，新版对不上，请用旧版导的文件配旧版插件，或重新导一份"
          : "这不像网站数据备份的头一行，可能选错了文件（导 Cookie 的文件不能用来导网站数据）";
        return;
      }
      const c = /"siteCount":(\d+)/.exec(s);
      if (c) total = Number(c[1]);
      if (s.includes('"origins":[')) inOrigins = true;
      return;
    }

    if (s[0] === "]") return; // 收尾那行

    const task = (async () => {
      try {
        await importOne(s);
      } finally {
        inflight.delete(task);
      }
    })();
    inflight.add(task);
  });

  const decoder = new TextDecoder();
  try {
    for (let i = 0; i < incoming.chunks.length; i++) {
      const chunk = incoming.chunks[i];
      incoming.chunks[i] = null; // 这块用完了，让内存能回收
      reader.push(decoder.decode(chunk, { stream: true }));
      // 排队的网站太多就先等等，别让内存一路涨
      while (!badFormat && pool.created && inflight.size - pool.created > pool.created * 2) await Promise.race(inflight);
      if (badFormat) break;
    }
    reader.push(decoder.decode());
    reader.end();
    if (!inOrigins && !badFormat) badFormat = "文件里没有网站数据那一段，可能选错了文件";

    if (!badFormat) {
      while (inflight.size) await Promise.race(inflight);
    }
  } finally {
    incoming = { chunks: [] };
    await pool.close();
  }

  if (badFormat) {
    post({ type: "siteData:done", ok: false, error: badFormat });
    return;
  }
  post({ type: "siteData:done", ok: true, phase: "import", ...stats, failureCount: failure.count, failures: failure.list.slice(0, 10) });
}

function downloadAndRelease(url, filename) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(listener);
      URL.revokeObjectURL(url);
      resolve();
    };
    const listener = (delta) => {
      if (!delta.state) return;
      if (delta.state.current === "complete" || delta.state.current === "interrupted") finish();
    };
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.download({ url, filename, saveAs: true }, (id) => {
      if (chrome.runtime.lastError) finish();
    });
    setTimeout(finish, 10 * 60 * 1000);
  });
}

function post(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function closeShop() {
  if (engineWindowId != null) {
    try {
      await chrome.windows.remove(engineWindowId);
      return;
    } catch {}
  }
  window.close();
}

// ---------- 消息入口 ----------

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === "engine:ping") {
    post({ type: "engine:pong" });
    return;
  }

  if (msg.type === "siteData:file") {
    incoming.chunks.push(b64ToBytes(msg.data));
    return;
  }

  if (msg.type === "siteData:run") {
    if (busy) {
      post({ type: "siteData:done", ok: false, error: "已经有一个任务在跑了，等它做完再点" });
      return;
    }
    busy = true;
    const work = msg.op === "import" ? runImport() : runExport(msg.payload);
    work
      .catch((e) => post({ type: "siteData:done", ok: false, error: e.message || String(e) }))
      .then(() => {
        busy = false;
        closeShop();
      });
    return;
  }
});

(async function init() {
  const win = await chrome.windows.getCurrent();
  engineWindowId = win.id;
  post({ type: "engine:ready" });
})();
