// 网站数据处理页：负责"假访问"每个网站，读出/写回它的本地存储和 IndexedDB。
// 全程不发网络请求：导航在发出前就被拦截，由本地假页面顶上，浏览器只认页面地址属于哪个网站。

const CDP = "1.3";
const FAKE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Cookie Transfer</title></head><body></body></html>';
const FEED_SIZE = 1024 * 1024;
const WORKER_COUNT = 3;
const NAV_TIMEOUT = 20000;
const FORMAT = "cookie-transfer-sitedata-v1";

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
    this.wantOrigin = null;
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

  // 让浏览器"进入"某个网站的页面：地址是它的，内容是假的
  async goto(origin) {
    this.wantOrigin = origin;
    this.ctx = null;
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
      if (c.origin === this.wantOrigin && this.onReady) {
        this.ctx = c.id;
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
  window.__CT_ACC = "";

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

// ---------- 导出 ----------

async function runExport(payload) {
  const origins = await buildOriginList(payload || {});
  if (!origins.length) {
    post({ type: "siteData:done", ok: false, error: "没有任何要处理的网站，请勾选自动收集或填写网址" });
    return;
  }

  const captured = new Set();
  const parts = [`{"format":${JSON.stringify(FORMAT)},"exportedAt":${JSON.stringify(new Date().toISOString())},"originCount":${origins.length},"origins":[`];
  const failures = [];
  const stats = { sites: 0, localStorageKeys: 0, databases: 0, records: 0, blobBytes: 0, bytes: 0 };
  let first = true;
  let done = 0;
  const total = origins.length;
  const report = (current) => post({ type: "siteData:progress", phase: "export", done, total, current });

  const workers = [];
  try {
    for (let i = 0; i < WORKER_COUNT; i++) {
      try {
        workers.push(await WorkerTab.create(engineWindowId));
      } catch (e) {
        if (!workers.length) throw e;
        break;
      }
    }

    let cursor = 0;
    const pump = async (w) => {
      while (cursor < origins.length) {
        const origin = origins[cursor++];
        if (captured.has(origin)) {
          done++;
          continue;
        }
        report(origin);
        try {
          await w.goto(origin);
          const actual = await w.evaluate("location.origin");
          if (captured.has(actual)) continue;
          captured.add(actual);

          const meta = await w.evaluate(`(${pageDump.toString()})()`, { awaitPromise: true, timeout: 300000 });
          const count = await w.evaluate("window.__CT_PARTS ? window.__CT_PARTS.length : 0");
          // 先整份收齐再一次性拼上去，否则几个网站同时写会互相穿插
          const pieces = [];
          for (let i = 0; i < count; i++) pieces.push(await w.evaluate(`window.__CT_PARTS[${i}]`));
          await w.evaluate("delete window.__CT_PARTS");

          if (!first) parts.push(",");
          first = false;
          for (const p of pieces) parts.push(p);

          stats.sites += 1;
          stats.localStorageKeys += meta.localStorage;
          stats.databases += meta.databases;
          stats.records += meta.records;
          stats.blobBytes += meta.blobBytes;
          stats.bytes += meta.bytes;
          for (const n of meta.notes || []) failures.push(actual + "：" + n);
        } catch (e) {
          failures.push(origin + "：" + (e.message || String(e)));
        } finally {
          done++;
        }
      }
    };

    await Promise.all(workers.map(pump));
  } finally {
    for (const w of workers) await w.stop();
  }

  parts.push(`],"failures":${JSON.stringify(failures)},"stats":${JSON.stringify(stats)}}`);

  const blob = new Blob(parts, { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const filename = `site-data-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

  post({ type: "siteData:done", ok: true, phase: "export", ...stats, failedCount: failures.length, filename });

  await downloadAndRelease(url, filename);
}

// ---------- 导入 ----------

async function runImport() {
  const bytes = new Uint8Array(incoming.chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of incoming.chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  incoming = { chunks: [] };

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    return post({ type: "siteData:done", ok: false, error: "文件读不懂，可能不是本插件导出的：" + e.message });
  }
  if (!payload || payload.format !== FORMAT || !Array.isArray(payload.origins)) {
    return post({ type: "siteData:done", ok: false, error: "文件格式不对，这不是网站数据导出文件（导 Cookie 的文件不能用来导网站数据）" });
  }

  const entries = payload.origins.filter((e) => e && typeof e.origin === "string" && /^https?:/.test(e.origin));
  const failures = [];
  const stats = { sites: 0, localStorageKeys: 0, databases: 0, records: 0 };
  let done = 0;
  const total = entries.length;
  const report = (current) => post({ type: "siteData:progress", phase: "import", done, total, current });

  const workers = [];
  try {
    for (let i = 0; i < WORKER_COUNT; i++) {
      try {
        workers.push(await WorkerTab.create(engineWindowId));
      } catch (e) {
        if (!workers.length) throw e;
        break;
      }
    }

    let cursor = 0;
    const pump = async (w) => {
      while (cursor < entries.length) {
        const entry = entries[cursor++];
        report(entry.origin);
        try {
          await w.goto(entry.origin);
          const text = JSON.stringify(entry);
          await w.evaluate("window.__CT_ACC = ''");
          for (let i = 0; i < text.length; i += FEED_SIZE) {
            await w.evaluate("__CT_ACC += " + JSON.stringify(text.slice(i, i + FEED_SIZE)));
          }
          const r = await w.evaluate(`(${pageRestore.toString()})()`, { awaitPromise: true });
          stats.sites += 1;
          stats.localStorageKeys += r.localStorage;
          stats.databases += r.databases;
          stats.records += r.records;
          for (const n of r.notes || []) failures.push(entry.origin + "：" + n);
        } catch (e) {
          failures.push(entry.origin + "：" + (e.message || String(e)));
        } finally {
          done++;
        }
      }
    };

    await Promise.all(workers.map(pump));
  } finally {
    for (const w of workers) await w.stop();
  }

  post({ type: "siteData:done", ok: true, phase: "import", ...stats, failedCount: failures.length, failures: failures.slice(0, 40) });
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
