// Cookie Transfer 的应用页：弹窗和独立窗口共用这一份代码。
// 弹窗只当入口；网站数据的搬迁一定在独立窗口里跑，因为它不能被浏览器提前收掉。

const MODE = new URLSearchParams(location.search).get("mode") === "window" ? "window" : "popup";
// 立刻打上模式标记，页面样式靠它区分弹窗形态和独立窗口形态
document.body.dataset.mode = MODE;

const CDP = "1.3";
const PUSH = "__ctPush"; // 空壳页往这边推数据的口子（由调试协议装进页面）
const FAKE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Cookie Transfer</title></head><body></body></html>';

const FEED_SIZE = 1024 * 1024; // 导入时一次喂给页面的文字长度

const CALL_TIMEOUT = 60000; // 单条指令
const NAV_TIMEOUT = 20000; // 进一个网站
const JOB_TIMEOUT = 300000; // 整站转储 / 写回
const PUSH_IDLE_TIMEOUT = 60000; // 整站干活期间，两次推送之间最长允许隔多久
const SHELL_KEEP_MS = 3000; // 手上没活时页面先留一会儿，别来回开关

const WORKER_MIN = 1;
const WORKER_MAX = 20;
const WORKER_DEFAULT = 3;
const IMPORT_QUEUE_MAX = 8; // 导入时最多排几个网站，防止把整个备份读进内存
const FAILURE_LIMIT = 200; // 失败详情最多留几条，别把备份文件撑爆

const FORMAT = "cookie-transfer-sitedata-v3";
const JOB_KEY = "ctRunningJob";
const WINDOW_KEY = "ctWindowId";

// 只能对普通网站动手脚，浏览器商店之类的页面排除在外
const SKIP_HOSTS = new Set(["chromewebstore.google.com", "addons.microsoft.com"]);

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------- 界面 ----------

const el = (id) => document.getElementById(id);
let busy = false;
let cancelRequested = false;
let myWindowId = null;

function setStatus(text, isError) {
  el("status").textContent = text || "";
  el("status").style.color = isError ? "#c00" : "#333";
}

function setProgress(pct, text) {
  if (MODE !== "window") return;
  if (pct === null) {
    el("progress").hidden = true;
    return;
  }
  el("progress").hidden = false;
  el("bar").style.width = Math.min(100, pct) + "%";
  el("barText").textContent = pct + "%" + (text ? "　" + text : "");
}

function fmtNum(n) {
  return Math.round(n).toLocaleString("zh-CN");
}

function fmtMB(bytes) {
  return (bytes / 1048576).toFixed(1) + " MB";
}

function addLog(text) {
  if (MODE !== "window" || !text) return;
  const li = document.createElement("li");
  li.textContent = text;
  el("log").appendChild(li);
  while (el("log").children.length > 300) el("log").removeChild(el("log").firstChild);
  el("logBox").scrollTop = el("logBox").scrollHeight;
}

// 独立窗口的实时状态镜像进内存存储，弹窗那边才能显示"正在跑"
let publishAt = 0;
async function publish(state, force) {
  if (MODE !== "window") return;
  const now = Date.now();
  if (!force && state && now - publishAt < 300) return;
  publishAt = now;
  if (state) await chrome.storage.session.set({ [JOB_KEY]: { ...state, windowId: myWindowId } });
  else await chrome.storage.session.remove(JOB_KEY);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ---------- 并发数与要处理的网站清单 ----------

async function workerLimit() {
  const { concurrency } = await chrome.storage.local.get("concurrency");
  const n = Math.floor(Number(concurrency));
  return Number.isFinite(n) ? Math.min(WORKER_MAX, Math.max(WORKER_MIN, n)) : WORKER_DEFAULT;
}

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

// 从 Cookie 里只能拿到域名，猜不到用哪个协议，所以 https 和 http 都列上
function originsFromDomain(domain) {
  const host = (domain || "").replace(/^\./, "");
  if (!host) return [];
  return [`https://${host}`, `http://${host}`];
}

async function buildOriginList({ useBrowserList, manualText }) {
  const list = [];
  const seen = new Set();
  const add = (origin) => {
    if (origin && !seen.has(origin)) {
      seen.add(origin);
      list.push(origin);
    }
  };

  for (const line of (manualText || "").split(/[\s,;]+/)) {
    if (!line) continue;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(line) ? line : "https://" + line;
    add(originOf(withScheme));
  }

  if (useBrowserList) {
    for (const t of await chrome.tabs.query({})) add(originOf(t.url));
    for (const c of await chrome.cookies.getAll({})) for (const o of originsFromDomain(c.domain)) add(o);
    for (const v of await chrome.history.search({ text: "", startTime: 0, maxResults: 0 })) add(originOf(v.url));
  }

  return list;
}

// ---------- 空壳页面：地址是那个网站的、内容是本地现造的 ----------

const shellsByTab = new Map();
let workerWindowId = null;
let workerWindowTask = null; // 建窗口这件事同一时刻只让一个人干，其他人等它的结果

// 干活窗口永远只有一个，里面按"同时干活的数量"开若干后台标签页。
// 之前少了这把锁：几个工作循环同时发现"还没窗口"，就各建了一个，等于开了跟并发数一样多的窗口。
function ensureWorkerWindow() {
  if (!workerWindowTask) {
    workerWindowTask = createWorkerWindow().finally(() => {
      workerWindowTask = null;
    });
  }
  return workerWindowTask;
}

async function createWorkerWindow() {
  if (workerWindowId != null) {
    try {
      await chrome.windows.get(workerWindowId);
      return workerWindowId;
    } catch {
      workerWindowId = null; // 窗口已经被关了，重新开一个
    }
  }
  let win;
  try {
    // 最小化不占地方；有的环境（比如无头测试）不接受这个参数，就退回一个小窗口
    win = await chrome.windows.create({ url: "about:blank", focused: false, state: "minimized", width: 480, height: 320 });
  } catch {
    win = await chrome.windows.create({ url: "about:blank", focused: false, width: 480, height: 320 });
  }
  workerWindowId = win.id;
  return workerWindowId;
}

async function releaseWorkerWindow() {
  const id = workerWindowId;
  workerWindowId = null;
  workerWindowTask = null;
  if (id != null) await chrome.windows.remove(id).catch(() => {});
}

class Shell {
  constructor(tabId) {
    this.tabId = tabId;
    this.ctx = null;
    this.origin = null;
    this.ready = null; // 等"进到了网站里"
    this.parts = []; // 空壳页推过来的文字
    this.cursor = 0; // 已经取走了几条
    this.waiter = null; // 等在途文字的人
    this.timer = null;
    this.dead = null; // 死因：调试断了、页面被关了、半天没动静
  }

  // 开页面偶尔会失败一次（干活窗口刚被浏览器收走、调试器一时腾不出手），重试三次再认输
  static async create() {
    let last = null;
    for (let tryNo = 1; tryNo <= 3; tryNo++) {
      try {
        return await Shell.openOnce();
      } catch (e) {
        last = e;
        workerWindowId = null; // 多半是那个窗口没了，下一轮重新开一个
      }
    }
    throw new Error("开不出工作页面：" + (last.message || String(last)));
  }

  static async openOnce() {
    const windowId = await ensureWorkerWindow();
    const tab = await chrome.tabs.create({ url: "about:blank", active: false, windowId });
    const shell = new Shell(tab.id);
    shellsByTab.set(tab.id, shell);
    try {
      await chrome.debugger.attach({ tabId: tab.id }, CDP);
      await shell.cmd("Page.enable");
      await shell.cmd("Runtime.enable");
      await shell.cmd("Runtime.addBinding", { name: PUSH });
      await shell.cmd("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    } catch (e) {
      await shell.dispose();
      throw e;
    }
    return shell;
  }

  cmd(method, params) {
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params || {});
  }

  async dispose() {
    shellsByTab.delete(this.tabId);
    this.clearTimer();
    try {
      await chrome.debugger.detach({ tabId: this.tabId });
    } catch {}
    try {
      await chrome.tabs.remove(this.tabId);
    } catch {}
  }

  markDead(reason) {
    if (this.dead) return;
    this.dead = reason;
    this.rejectWaiters(this.deadError());
  }

  deadError() {
    const e = new Error(this.dead);
    e.stalled = true;
    return e;
  }

  rejectWaiters(e) {
    if (this.ready) {
      const slot = this.ready;
      this.ready = null;
      slot.rej(e);
    }
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.rej(e);
    }
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // 等文字期间挂着一张表：长时间没动静就说明这个页面卡死了，换掉它
  armTimer() {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.markDead("这个网站的页面半天没动静");
    }, PUSH_IDLE_TIMEOUT);
  }

  resetParts() {
    this.parts = [];
    this.cursor = 0;
  }

  takeParts() {
    const out = [];
    while (this.parts.length > this.cursor) {
      out.push(this.parts[this.cursor]);
      this.parts[this.cursor++] = "";
    }
    if (this.cursor > 64) {
      this.parts = this.parts.slice(this.cursor);
      this.cursor = 0;
    }
    return out;
  }

  // 手上没有排队文字时等下一段；推送一到就把这里叫醒
  waitPart() {
    if (this.dead) return Promise.reject(this.deadError());
    if (this.parts.length > this.cursor) return Promise.resolve();
    return new Promise((res, rej) => {
      this.waiter = { res, rej };
      this.armTimer();
    });
  }

  // 让浏览器"进入"某个网站：地址是它的，内容是本地现造的。
  // 返回文档真正落在哪个地址上（新旧地址可能被浏览器改写），不用再额外问一次。
  async goto(origin) {
    this.ctx = null;
    this.origin = null;
    let slot;
    const committed = new Promise((res, rej) => {
      slot = { res, rej };
      this.ready = slot;
      setTimeout(() => {
        if (this.ready !== slot) return;
        this.ready = null;
        const e = new Error("打开网站外壳超时");
        e.stalled = true;
        rej(e);
      }, NAV_TIMEOUT);
    });
    const nav = await this.cmd("Page.navigate", { url: origin + "/" });
    if (nav && nav.errorText) throw new Error("导航失败：" + nav.errorText);
    await committed;
    return this.origin;
  }

  // 在页面里执行一段代码。每条指令都有截止时间：页面被浏览器丢掉或卡死时，不能拖住整批。
  run(expression, { awaitPromise = false, timeout = CALL_TIMEOUT } = {}) {
    if (this.dead) return Promise.reject(this.deadError());
    const done = this.cmd("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      contextId: this.ctx || undefined,
    }).then((res) => {
      if (res.exceptionDetails)
        throw new Error("页面内执行出错：" + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
      return res.result.value;
    });
    // 超时之后那条指令还在天上飞，结果不要了；先把它的失败吃掉，免得控制台里全是没主的报错
    done.catch(() => {});
    return Promise.race([done, timeoutAfter(timeout, "这条指令等超时了")]);
  }

  handleEvent(method, params) {
    if (method === "Runtime.executionContextCreated") {
      const c = params.context;
      // 只认普通网站地址的文档；about:blank 之类不算"进到了网站里"
      if (this.ready && /^https?:/.test(c.origin)) {
        this.ctx = c.id;
        this.origin = c.origin;
        const slot = this.ready;
        this.ready = null;
        slot.res();
      }
    } else if (method === "Runtime.executionContextDestroyed") {
      if (params.executionContextId === this.ctx) this.ctx = null;
    } else if (method === "Runtime.bindingCalled") {
      if (params.name !== PUSH) return;
      this.clearTimer();
      this.parts.push(params.payload);
      const w = this.waiter;
      if (w) {
        this.waiter = null;
        w.res();
      }
    } else if (method === "Fetch.requestPaused") {
      this.answerFake(params.requestId);
    }
  }

  // 每个请求都在发出前被拦下，用本地造的空壳顶掉，所以全程不联网
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
  shellsByTab.get(source.tabId)?.handleEvent(method, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  shellsByTab.get(source.tabId)?.markDead("调试连接被断开（" + reason + "）");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  shellsByTab.get(tabId)?.markDead("工作页面被关掉了");
  // 这里不去动干活窗口：正常收尾也会走到这条，误判成"窗口没了"会 repeatedly 多开一个窗口
});

function timeoutAfter(ms, text) {
  return new Promise((_r, rej) =>
    setTimeout(() => {
      const e = new Error(text);
      e.stalled = true;
      rej(e);
    }, ms)
  );
}

function stringToB64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------- 活计分配：每个工作循环自己守一个页面 ----------
// 上一版是"几个循环抢一个公共池"，池子补充失败时会有循环永远等不到页面，进度就钉在某个数字不动。
// 现在每个循环自带一个页面，它只等自己手上的活，不可能把别人堵死。

class Runner {
  constructor({ limit, handle, onDone, onFail }) {
    this.limit = limit;
    this.handle = handle;
    this.onDone = onDone;
    this.onFail = onFail;
    this.queue = [];
    this.workers = 0;
    this.sealed = false;
    this.fatal = null;
    this.idleWaiters = [];
    this.workWaiters = [];
  }

  add(item) {
    this.queue.push(item);
    const wake = this.workWaiters.shift();
    if (wake) wake();
    while (this.workers < this.limit && this.queue.length) this.spawn();
  }

  seal() {
    this.sealed = true;
    this.wakeAll();
  }

  // 排队的网站太多时，生产者在这儿等一等，别让内存一路涨。
  // 这里刻意用"问一句、歇一下"，而不是挂一个回调等通知：挂了回调的写法，在用户按了中止、
  // 干活的循环全部退出之后，就永远等不到空位，导入会卡死在读文件那一步。
  async waitForRoom() {
    while (this.queue.length >= IMPORT_QUEUE_MAX && !cancelRequested && !this.fatal) await sleep(50);
  }

  async wait() {
    this.seal();
    while (this.workers) await new Promise((res) => this.idleWaiters.push(res));
    if (this.fatal) throw this.fatal;
  }

  wakeAll() {
    const list = this.workWaiters;
    this.workWaiters = [];
    for (const w of list) w();
  }

  spawn() {
    this.workers++;
    this.loop().finally(() => {
      this.workers--;
      if (!this.workers) this.idleWaiters.splice(0).forEach((res) => res());
    });
  }

  take() {
    if (!this.queue.length) return undefined;
    return this.queue.shift();
  }

  async loop() {
    let shell = null;
    try {
      while (!this.fatal && !cancelRequested) {
        if (!this.queue.length) {
          if (this.sealed) return;
          await this.waitForWork();
          continue;
        }
        const item = this.take();
        if (item === undefined) continue; // 被别的循环抢先了
        if (!shell) {
          try {
            shell = await Shell.create();
          } catch (e) {
            this.queue.unshift(item); // 页面开不出来，这个网址退回队里，整批就此收工
            this.fatal = e;
            return;
          }
        }
        try {
          await this.handle(shell, item);
          this.onDone(shell, item);
        } catch (e) {
          if (e.fatal) {
            this.fatal = e;
            return;
          }
          this.onFail(shell, item, e);
          // 卡死或被踢掉的页面不能再用：它下一个网站多半还是卡
          if (shell.dead || e.stalled) {
            await shell.dispose().catch(() => {});
            shell = null;
          }
        }
      }
    } finally {
      if (shell) await shell.dispose().catch(() => {});
    }
  }

  // 手上没活时先别撤页面：生产者可能马上就喂进来一个
  waitForWork() {
    if (this.queue.length || this.sealed || this.fatal || cancelRequested) return Promise.resolve();
    return new Promise((res) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        res();
      };
      const timer = setTimeout(() => {
        const i = this.workWaiters.indexOf(finish);
        if (i >= 0) this.workWaiters.splice(i, 1);
        finish();
      }, SHELL_KEEP_MS);
      this.workWaiters.push(finish);
    });
  }
}

// 把空壳页推过来的文字收齐：说好多少字符，差一个都不算完
async function collectParts(shell, expect) {
  const out = [];
  let got = 0;
  while (got < expect) {
    const parts = shell.takeParts();
    if (!parts.length) {
      await shell.waitPart();
      continue;
    }
    for (const p of parts) {
      out.push(p);
      got += p.length;
    }
  }
  if (got > expect) throw new Error("页面推来的文字比说好的多，这份备份不可信");
  return out;
}

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

// ---------- 页面里跑的两个大函数（会被转成文字送进页面，所以不能引用外面任何东西）----------

async function pageDump(wantLocalStorage, wantIndexedDB) {
  if (typeof window.__ctPush !== "function") throw new Error("空壳页的推送通道没装上");

  const PUSH_SIZE = 512 * 1024; // 攒够这么多文字就推一次
  // 分块转 base64 的块大小必须是 3 的倍数：不然每一块都会补一个 "="，拼起来就解码不了
  const B64_CHUNK = 512 * 1024 - ((512 * 1024) % 3);
  const ROW_BATCH_COUNT = 500; // 一批最多捞多少条记录
  const ROW_BATCH_BYTES = 4 * 1024 * 1024; // 一批最多捞多少字节

  let buf = "";
  let chars = 0;
  let blobBytes = 0;

  // 直接拼 JSON 文字：一个网站的备份是一块一块推出去的，不会先在页面里攒出整份
  function push(text) {
    buf += text;
    chars += text.length;
    if (buf.length >= PUSH_SIZE) {
      window.__ctPush(buf);
      buf = "";
    }
  }

  function toB64(u) {
    let bin = "";
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function pushBlobData(b) {
    push('"');
    for (let off = 0; off < b.size; off += B64_CHUNK) {
      const part = await b.slice(off, Math.min(off + B64_CHUNK, b.size)).arrayBuffer();
      push(toB64(new Uint8Array(part)));
    }
    push('"');
  }

  async function pushViewData(u, total) {
    push('"');
    for (let off = 0; off < total; off += B64_CHUNK) push(toB64(u.subarray(off, Math.min(off + B64_CHUNK, total))));
    push('"');
  }

  async function enc(v, seen) {
    if (v === null) return push("null");
    const t = typeof v;
    if (t === "string" || t === "boolean") return push(JSON.stringify(v));
    if (t === "number") return push(Number.isFinite(v) ? String(v) : JSON.stringify({ __: "num", v: String(v) }));
    if (t === "undefined") return push(JSON.stringify({ __: "und" }));
    if (t === "bigint") return push(JSON.stringify({ __: "bi", v: String(v) }));
    if (t === "function" || t === "symbol") return push(JSON.stringify({ __: "skip" }));

    if (typeof File !== "undefined" && v instanceof File) {
      blobBytes += v.size;
      push(
        '{"__":"file","name":' +
          JSON.stringify(v.name) +
          ',"type":' +
          JSON.stringify(v.type) +
          ',"lastModified":' +
          (Number.isFinite(v.lastModified) ? v.lastModified : 0) +
          ',"size":' +
          v.size +
          ',"data":'
      );
      await pushBlobData(v);
      return push("}");
    }
    if (typeof Blob !== "undefined" && v instanceof Blob) {
      blobBytes += v.size;
      push('{"__":"blob","type":' + JSON.stringify(v.type) + ',"size":' + v.size + ',"data":');
      await pushBlobData(v);
      return push("}");
    }
    if (v instanceof Date) return push(JSON.stringify({ __: "date", v: Number.isNaN(v.getTime()) ? null : v.getTime() }));
    if (v instanceof RegExp) return push(JSON.stringify({ __: "re", s: v.source, f: v.flags }));
    if (v instanceof ArrayBuffer) {
      blobBytes += v.byteLength;
      push('{"__":"ab","data":');
      await pushViewData(new Uint8Array(v), v.byteLength);
      return push("}");
    }
    if (ArrayBuffer.isView(v)) {
      blobBytes += v.buffer.byteLength;
      push(
        v instanceof DataView
          ? '{"__":"dv","o":' + v.byteOffset + ',"l":' + v.byteLength + ',"data":'
          : '{"__":"tv","c":' + JSON.stringify(v.constructor.name) + ',"o":' + v.byteOffset + ',"l":' + v.length + ',"data":'
      );
      await pushViewData(new Uint8Array(v.buffer), v.buffer.byteLength);
      return push("}");
    }
    if (typeof IDBKeyRange !== "undefined" && v instanceof IDBKeyRange) {
      return push(JSON.stringify({ __: "kr", lo: v.lower, up: v.upper, lb: v.lowerOpen, ub: v.upperOpen }));
    }
    if (typeof v !== "object") return push(JSON.stringify(String(v)));
    if (seen.has(v)) return push(JSON.stringify({ __: "cyc" }));
    seen.add(v);

    if (v instanceof Map) {
      push('{"__":"map","e":[');
      let first = true;
      for (const [k, x] of v) {
        if (!first) push(",");
        first = false;
        push("[");
        await enc(k, seen);
        push(",");
        await enc(x, seen);
        push("]");
      }
      push("]}");
    } else if (v instanceof Set) {
      push('{"__":"set","e":[');
      let first = true;
      for (const x of v) {
        if (!first) push(",");
        first = false;
        await enc(x, seen);
      }
      push("]}");
    } else if (Array.isArray(v)) {
      push('{"__":"arr","l":' + v.length + ',"e":[');
      for (let i = 0; i < v.length; i++) {
        if (i) push(",");
        if (i in v) await enc(v[i], seen);
        else push(JSON.stringify({ __: "hole" }));
      }
      push("]}");
    } else {
      push('{"__":"obj","e":[');
      let first = true;
      for (const [k, x] of Object.entries(v)) {
        if (!first) push(",");
        first = false;
        push("[" + JSON.stringify(k) + ",");
        await enc(x, seen);
        push("]");
      }
      push("]}");
    }
    seen.delete(v);
  }

  function txdone(tx) {
    return new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onabort = () => rej(tx.error || new Error("事务被中止"));
      tx.onerror = () => rej(tx.error || new Error("事务出错"));
    });
  }

  function openDb(name) {
    return new Promise((res, rej) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error("打不开数据库"));
      r.onblocked = () => rej(new Error("被其他页面占用"));
    });
  }

  async function storeMeta(db, name) {
    const tx = db.transaction(name, "readonly");
    const st = tx.objectStore(name);
    const meta = {
      keyPath: st.keyPath,
      auto: st.autoIncrement,
      indexes: Array.from(st.indexNames).map((n) => {
        const ix = st.index(n);
        return { name: n, keyPath: ix.keyPath, unique: ix.unique, multi: ix.multiEntry };
      }),
    };
    await txdone(tx);
    return meta;
  }

  // 文件类数据是流着读的，不占页面内存，所以一条记录只按表面大小估一估
  function roughSize(v) {
    if (typeof v === "string") return v.length;
    if (!v || typeof v !== "object") return 8;
    if ((typeof Blob !== "undefined" && v instanceof Blob) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return 16;
    let n = 16;
    for (const x of Object.values(v)) n += typeof x === "string" ? x.length : 8;
    return n;
  }

  // 一批一批地捞记录：捞一批、推一批、把这批丢掉。几百万条的数据库也不会把页面压垮。
  async function readBatch(db, name, after) {
    const tx = db.transaction(name, "readonly");
    const st = tx.objectStore(name);
    const range = after === undefined ? null : IDBKeyRange.lowerBound(after, true);
    const rows = [];
    let bytes = 0;
    let ended = false;
    await new Promise((res, rej) => {
      const req = st.openCursor(range);
      req.onsuccess = () => {
        const c = req.result;
        if (!c) {
          ended = true;
          return res();
        }
        rows.push({ key: c.key, value: c.value });
        bytes += roughSize(c.value);
        if (rows.length >= ROW_BATCH_COUNT || bytes >= ROW_BATCH_BYTES) return res();
        c.continue();
      };
      req.onerror = () => rej(req.error);
    });
    await txdone(tx);
    return { rows, ended };
  }

  const meta = { localStorage: 0, databases: 0, records: 0, blobBytes: 0, notes: [] };

  push('{"origin":' + JSON.stringify(location.origin));

  if (wantLocalStorage) {
    const pairs = Object.entries(localStorage);
    push(',"localStorage":[');
    for (let i = 0; i < pairs.length; i++) {
      if (i) push(",");
      push(JSON.stringify(pairs[i]));
    }
    push("]");
    meta.localStorage = pairs.length;
  }

  let dbs = [];
  if (wantIndexedDB) {
    try {
      dbs = await indexedDB.databases();
    } catch (e) {
      meta.notes.push("这个网站的数据库清单读不了（普通网站才有）：" + e.message);
    }
  }
  // 没勾上的那一样整段都不写进备份，读的时候当它没有
  if (wantIndexedDB) push(',"indexedDB":[');
  let firstDb = true;
  for (const info of dbs) {
    let db;
    let dbOpen = false;
    let storeOpen = false;
    try {
      db = await openDb(info.name);
      if (!firstDb) push(",");
      firstDb = false;
      push('{"name":' + JSON.stringify(info.name) + ',"version":' + JSON.stringify(info.version) + ',"stores":[');
      dbOpen = true;
      const names = Array.from(db.objectStoreNames);
      let firstStore = true;
      for (const name of names) {
        const m = await storeMeta(db, name);
        if (!firstStore) push(",");
        firstStore = false;
        push(
          '{"name":' +
            JSON.stringify(name) +
            ',"keyPath":' +
            JSON.stringify(m.keyPath) +
            ',"auto":' +
            JSON.stringify(!!m.auto) +
            ',"indexes":' +
            JSON.stringify(m.indexes) +
            ',"recs":['
        );
        storeOpen = true;
        let after;
        let first = true;
        for (;;) {
          const batch = await readBatch(db, name, after);
          for (const r of batch.rows) {
            if (!first) push(",");
            first = false;
            push('{"key":');
            await enc(r.key, new Set());
            push(',"value":');
            await enc(r.value, new Set());
            push("}");
            meta.records++;
          }
          if (batch.rows.length) after = batch.rows[batch.rows.length - 1].key;
          if (batch.ended) break;
        }
        push("]}");
        storeOpen = false;
      }
      push("]}");
      dbOpen = false;
      meta.databases++;
    } catch (e) {
      meta.notes.push("数据库 " + info.name + " 读不了：" + e.message);
      // 已经开口的括号得闭合，否则这一行 JSON 就断了，整条记录都读不出来
      if (storeOpen) push("]}");
      if (dbOpen) push("]}");
    } finally {
      if (db) db.close();
    }
  }
  if (wantIndexedDB) push("]");
  push("}");

  if (buf) {
    window.__ctPush(buf);
    buf = "";
  }
  meta.chars = chars;
  meta.blobBytes = blobBytes;
  return meta;
}

async function pageRestore(expectChars, wantLocalStorage, wantIndexedDB) {
  const text = window.__CT_ACC;
  window.__CT_ACC = null;
  if (typeof text !== "string") throw new Error("没收到这个网站的备份内容");
  if (text.length !== expectChars) throw new Error("备份内容送少了：" + text.length + " 不该是 " + expectChars);

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

  const entry = JSON.parse(text);
  const result = { localStorage: 0, databases: 0, records: 0, notes: [] };

  if (wantLocalStorage) {
    for (const [k, v] of entry.localStorage || []) {
      localStorage.setItem(k, v);
      result.localStorage++;
    }
  }

  // 没勾上的那一样，备份里有也不往网站上写
  for (const d of (wantIndexedDB ? entry.indexedDB || [] : [])) {
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
      result.databases++;
    } catch (e) {
      result.notes.push("数据库 " + d.name + " 写不进去：" + e.message);
    }
  }

  return result;
}

// ---------- 边跑边写的文件，和挑文件的框 ----------

class FileSink {
  constructor(writable) {
    this.w = writable;
    this.chain = Promise.resolve();
    this.err = null;
  }
  push(text) {
    this.chain = this.chain.then(() => this.w.write(text)).catch((e) => {
      this.err = this.err || e;
    });
  }
  async flush() {
    await this.chain;
    if (this.err) {
      const e = new Error("写文件失败：" + this.err.message);
      e.fatal = true;
      throw e;
    }
  }
  async close() {
    await this.flush();
    await this.w.close();
  }
}

// 另存为：必须先让用户点这一下挑文件，之后才能边跑边往里写
async function pickSaveFile(suggestedName) {
  let handle;
  try {
    handle = await showSaveFilePicker({
      suggestedName,
      types: [{ description: "JSON 备份文件", accept: { "application/json": [".json"] } }],
    });
  } catch (e) {
    if (e && e.name === "AbortError") {
      setStatus("已取消，没有写任何文件。", false);
      return null;
    }
    throw new Error("保存框打不开：" + (e.message || String(e)));
  }
  return new FileSink(await handle.createWritable());
}

// 选一个已有文件，交回 File 对象：导入靠它一行一行流式读，整个备份不进内存
async function pickFile(label) {
  let handles;
  try {
    handles = await showOpenFilePicker({
      multiple: false,
      types: [{ description: label, accept: { "application/json": [".json"] } }],
    });
  } catch (e) {
    if (e && e.name === "AbortError") {
      setStatus("已取消，没有选文件。", false);
      return null;
    }
    throw new Error("文件选择框打不开：" + (e.message || String(e)));
  }
  return handles[0].getFile();
}

// ---------- 导出网站数据：处理完一个网站就立刻写进文件 ----------

async function runExport({ useBrowserList, manualText, kinds }) {
  const sink = await pickSaveFile(`site-data-export-${stamp()}.json`);
  if (!sink) return;
  sink.push(`{"format":${JSON.stringify(FORMAT)}}\n`);

  const failure = makeFailureRecorder(FAILURE_LIMIT);
  const stats = { sites: 0, localStorageKeys: 0, databases: 0, records: 0, blobBytes: 0 };
  const captured = new Set();
  const inflight = new Map();
  let done = 0;

  function report() {
    const note = [...inflight.values()].slice(0, 3).join("、");
    const pct = origins.length ? Math.floor((done / origins.length) * 100) : 0;
    setProgress(pct, `${fmtNum(done)}/${fmtNum(origins.length)}　已写入 ${fmtNum(stats.sites)} 个网站${note ? "｜正在处理：" + note : ""}`);
    setStatus(`正在导出网站数据 ${fmtNum(done)}/${fmtNum(origins.length)}${note ? "｜正在处理：" + note : ""}`, false);
    publish({ running: true, op: "export", label: "导出网站数据", done, total: origins.length, note });
  }

  setStatus("正在清点要处理的网站……", false);
  const origins = await buildOriginList({ useBrowserList, manualText });
  if (!origins.length) {
    await finishExport(sink, stats, failure, 0);
    setStatus("没有任何要处理的网站：既没勾选自动收集，也没填网址。", true);
    return;
  }

  const runner = new Runner({
    limit: await workerLimit(),
    handle: async (shell, origin) => {
      inflight.set(shell, origin);
      report();
      shell.resetParts();
      const actual = await shell.goto(origin);
      // 同一个域名可能被浏览器改写成一个地址，地址一样就是同一块硬盘，跑过一遍就够
      if (captured.has(actual)) return;
      captured.add(actual);
      inflight.set(shell, actual);

      const meta = await shell.run(`(${pageDump.toString()})(${kinds.ls},${kinds.idb})`, {
        awaitPromise: true,
        timeout: JOB_TIMEOUT,
      });
      const pieces = await collectParts(shell, meta.chars);
      for (const n of meta.notes || []) failure.add(actual + "：" + n);
      if (meta.localStorage + meta.databases === 0) return; // 没勾的那类数据不算：这个网站没什么可写的

      for (const p of pieces) sink.push(p);
      sink.push("\n");
      stats.sites++;
      stats.localStorageKeys += meta.localStorage;
      stats.databases += meta.databases;
      stats.records += meta.records;
      stats.blobBytes += meta.blobBytes;
      await sink.flush(); // 写完这个才放下一个：内存里最多同时攒"同时在跑的那几个网站"
    },
    onDone: (shell) => {
      inflight.delete(shell);
      done++;
      report();
    },
    onFail: (shell, origin, e) => {
      inflight.delete(shell);
      done++;
      failure.add(origin + "：" + (e.message || String(e)));
      report();
    },
  });

  for (const o of origins) runner.add(o);
  try {
    await runner.wait();
  } finally {
    await finishExport(sink, stats, failure, captured.size);
  }

  const tail = cancelRequested ? "（按了中止，已经跑完的都在文件里）" : "";
  const written = [];
  if (kinds.ls) written.push(`本地存储 ${fmtNum(stats.localStorageKeys)} 条`);
  if (kinds.idb) written.push(`数据库 ${fmtNum(stats.databases)} 个（${fmtNum(stats.records)} 条记录）`);
  setStatus(
    `导出完成${tail}：扫了 ${fmtNum(captured.size)} 个网站，其中 ${fmtNum(stats.sites)} 个有你要搬的数据。` +
      written.join("，") +
      (stats.blobBytes ? `，文件类数据约 ${fmtMB(stats.blobBytes)}` : "") +
      (failure.count ? `；有 ${fmtNum(failure.count)} 项没能处理${failure.count > FAILURE_LIMIT ? "（只留了前 " + FAILURE_LIMIT + " 条详情）" : ""}` : "") +
      "。",
    false
  );
  for (const f of failure.list.slice(0, 20)) addLog(f);
}

async function finishExport(sink, stats, failure, scanned) {
  sink.push(
    `{"__summary":true,"complete":${JSON.stringify(!cancelRequested)},"scanned":${scanned},` +
      `"siteCount":${stats.sites},"failureCount":${failure.count},"stats":${JSON.stringify(stats)},` +
      `"failures":${JSON.stringify(failure.list)}}\n`
  );
  await sink.close();
}

// ---------- 导入网站数据：一行一行读，读一行干一行 ----------

async function runImport(kinds) {
  const file = await pickFile("网站数据备份");
  if (!file) return;

  const failure = makeFailureRecorder(FAILURE_LIMIT);
  const stats = { sites: 0, localStorageKeys: 0, databases: 0, records: 0 };
  const inflight = new Map();
  let loaded = 0;
  let wrote = 0;
  let summary = null;
  let headerSeen = false;
  let badFormat = null;

  function report() {
    const pct = file.size ? Math.floor((loaded / file.size) * 100) : 0;
    const note = [...inflight.values()].slice(0, 3).join("、");
    setProgress(pct, `${fmtMB(loaded)} / ${fmtMB(file.size)}　已写回 ${fmtNum(wrote)} 个网站${note ? "｜正在处理：" + note : ""}`);
    setStatus(`正在导入网站数据 ${pct}%（已写回 ${fmtNum(wrote)} 个网站）${note ? "｜正在处理：" + note : ""}`, false);
    publish({ running: true, op: "import", label: "导入网站数据", done: loaded, total: file.size, note });
  }

  const runner = new Runner({
    limit: await workerLimit(),
    handle: async (shell, item) => {
      inflight.set(shell, item.origin);
      report();
      const text = item.text;
      const actual = await shell.goto(item.origin);
      // 备份里写着这个地址，结果浏览器把地址改写了，说明这块硬盘不是当初那块，不往里写
      if (actual !== item.origin)
        throw new Error(`这个网站的地址被浏览器改写成了 ${actual}，为了不把数据写错地方，这条跳过了`);

      for (let i = 0, n = 0; i < text.length; i += FEED_SIZE, n++) {
        await shell.run((n ? "__CT_ACC += " : "window.__CT_ACC = ") + JSON.stringify(text.slice(i, i + FEED_SIZE)));
      }
      const r = await shell.run(`(${pageRestore.toString()})(${text.length},${kinds.ls},${kinds.idb})`, {
        awaitPromise: true,
        timeout: JOB_TIMEOUT,
      });
      if (r.localStorage + r.databases > 0) stats.sites++; // 你要搬的那类数据这条里一点都没有，就不算写回过一个网站
      stats.localStorageKeys += r.localStorage;
      stats.databases += r.databases;
      stats.records += r.records;
      for (const note of r.notes || []) failure.add(item.origin + "：" + note);
    },
    onDone: (shell) => {
      inflight.delete(shell);
      wrote++;
      report();
    },
    onFail: (shell, item, e) => {
      inflight.delete(shell);
      wrote++;
      failure.add("备份里一条记录没跑成：" + (e.message || String(e)) + "｜" + item.text.slice(0, 60) + "……");
      report();
    },
  });

  async function handleLine(line) {
    const s = line.trim();
    if (!s || cancelRequested) return;

    if (!headerSeen) {
      headerSeen = true;
      const f = /"format":"([^"]+)"/.exec(s);
      if (!f) {
        badFormat = "这不像网站数据备份的第一行，八成选错了文件（导 Cookies 的文件不能用来导网站数据）";
      } else if (f[1] !== FORMAT) {
        badFormat = f[1].startsWith("cookie-transfer-sitedata")
          ? `这份备份是 ${f[1]} 格式，和本插件（${FORMAT}）对不上：请用当初导出它的那个版本导入，或者重新导一份`
          : "这不是网站数据的备份文件，可能选错了";
      }
      return;
    }
    if (s.startsWith('{"__summary"')) {
      summary = safeParse(s);
      return;
    }

    const entry = safeParse(s);
    if (!entry || typeof entry.origin !== "string" || !/^https?:/.test(entry.origin)) {
      failure.add("备份里有一条记录的网站地址不对，跳过了：" + s.slice(0, 80));
      return;
    }
    await runner.waitForRoom(); // 排队的网站太多就先等等，别让内存一路涨
    if (cancelRequested) return;
    runner.add({ text: s, origin: entry.origin });
  }

  try {
    const decoder = new TextDecoder();
    const reader = file.stream().getReader();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      rest += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = rest.indexOf("\n")) >= 0) {
        const line = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        await handleLine(line);
      }
      if (badFormat || cancelRequested) break;
    }
    if (!badFormat && !cancelRequested) {
      rest += decoder.decode();
      if (rest) await handleLine(rest);
      if (!headerSeen) badFormat = "这个文件是空的，一行内容都没有。";
    }
    if (badFormat) {
      await runner.wait(); // 已经排上的网站还是会跑完，不能半途把写了一半的库丢在那儿
      setStatus(badFormat, true);
      return;
    }
    await runner.wait();
  } finally {
    runner.seal();
    await releaseWorkerWindow();
  }

  const restored = [];
  if (kinds.ls) restored.push(`本地存储 ${fmtNum(stats.localStorageKeys)} 条`);
  if (kinds.idb) restored.push(`数据库 ${fmtNum(stats.databases)} 个（${fmtNum(stats.records)} 条记录）`);
  setStatus(
    `导入完成：只写你勾的那几样，写回了 ${fmtNum(stats.sites)} 个网站，` +
      restored.join("，") +
      (failure.count ? `；有 ${fmtNum(failure.count)} 项没成功${failure.count > FAILURE_LIMIT ? "（只留前 " + FAILURE_LIMIT + " 条详情）" : ""}` : "") +
      (cancelRequested ? "（按了中止，没跑完的网址还在文件里，下次接着导就行）" : "") +
      "。",
    false
  );
  if (summary && summary.complete === false) addLog("提醒：这份备份当初是没跑完就停下的，里面只有部分网站。");
  for (const f of failure.list.slice(0, 20)) addLog(f);
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------- Cookies ----------

async function runCookieExport() {
  setStatus("正在读取全部 Cookies……", false);
  const cookies = await chrome.cookies.getAll({});
  const payload = {
    format: "cookie-transfer-v1",
    exportedAt: new Date().toISOString(),
    cookieCount: cookies.length,
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate,
      storeId: c.storeId,
      hostOnly: c.hostOnly,
      session: c.session,
    })),
  };

  const sink = await pickSaveFile(`cookies-export-${stamp()}.json`);
  if (!sink) return;
  sink.push(JSON.stringify(payload, null, 2));
  await sink.close();
  setStatus(`导出成功，共导出 ${fmtNum(cookies.length)} 个 Cookie，已写进你选的文件。`, false);
}

// 选文件、读文字（Cookies 文件小，一次读干净就行）
async function readPickedJson(label) {
  const file = await pickFile(label);
  if (!file) return null;
  return file.text();
}

// 一条一条串行写太慢，一小批一小批地并行
async function runCookieImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("文件格式错误，解析不成 JSON：" + e.message);
  }
  if (!data || data.format !== "cookie-transfer-v1" || !Array.isArray(data.cookies))
    throw new Error("无效的 Cookie 导入格式");

  const cookies = data.cookies;
  let success = 0;
  let failed = 0;
  setStatus(`正在导入 ${fmtNum(cookies.length)} 个 Cookie……`, false);

  for (let i = 0; i < cookies.length; i += 20) {
    const batch = cookies.slice(i, i + 20);
    const results = await Promise.all(batch.map(setOneCookie));
    for (const ok of results) ok ? success++ : failed++;
    const pct = cookies.length ? Math.floor(((i + batch.length) / cookies.length) * 100) : 0;
    setProgress(pct, `${fmtNum(i + batch.length)} / ${fmtNum(cookies.length)}`);
    publish({ running: true, op: "cookies", label: "导入 Cookies", done: i + batch.length, total: cookies.length }, true);
  }

  setStatus(`导入完成，总计 ${fmtNum(cookies.length)} 个，成功 ${fmtNum(success)} 个，失败 ${fmtNum(failed)} 个。`, false);
}

function setOneCookie(c) {
  const url = cookieUrl(c);
  if (!url) return Promise.resolve(false);

  const details = { url, name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly };
  // 有些版本读回来的 sameSite 是 "unspecified"，写的时候这个值不合法，只带标准值
  if (c.sameSite === "no_restriction" || c.sameSite === "lax" || c.sameSite === "strict") details.sameSite = c.sameSite;
  // 不带 storeId，否则跨浏览器、跨配置文件时会因为 storeId 对不上而全部失败
  if (!c.hostOnly && c.domain) details.domain = c.domain;
  if (!c.session && c.expirationDate) details.expirationDate = c.expirationDate;

  return chrome.cookies.set(details).then(
    (r) => !!r,
    () => false
  );
}

// 从 cookie 对象构造用于 chrome.cookies.set 的 URL
function cookieUrl(cookie) {
  let host = cookie.domain;
  if (!host || typeof host !== "string") return null;
  if (host.startsWith(".")) host = host.slice(1); // 域名级 cookie 前面那个点在 URL 里不能带
  return (cookie.secure ? "https://" : "http://") + host + (cookie.path || "/");
}

// ---------- 任务总控 ----------

async function withJob(label, fn) {
  if (busy) {
    setStatus("已经有一个任务在跑了，等它做完再点。", true);
    return;
  }
  busy = true;
  cancelRequested = false;
  el("cancel").hidden = false;
  setStatus(label + "中……", false);
  try {
    await fn();
  } catch (e) {
    setStatus("失败：" + ((e && e.message) || String(e)), true);
    addLog((e && e.stack) || String(e));
  } finally {
    busy = false;
    cancelRequested = false;
    el("cancel").hidden = true;
    setProgress(null);
    await publish(null, true);
    await releaseWorkerWindow();
  }
}

// ---------- 界面接线 ----------

const scopeInputs = {
  useBrowserList: { el: el("useBrowserList"), apply: (e, v) => (e.checked = v), value: (e) => e.checked },
  siteList: { el: el("siteList"), apply: (e, v) => (e.value = v), value: (e) => e.value },
  wantLocalStorage: { el: el("wantLocalStorage"), apply: (e, v) => (e.checked = v), value: (e) => e.checked },
  wantIndexedDB: { el: el("wantIndexedDB"), apply: (e, v) => (e.checked = v), value: (e) => e.checked },
  concurrency: {
    el: el("concurrency"),
    apply: (e, v) => (e.value = v),
    value: (e) => Math.min(WORKER_MAX, Math.max(WORKER_MIN, Number(e.value) || WORKER_DEFAULT)),
  },
};

// 把独立窗口叫出来；已经开着就只把它提到最前面，不重复开
async function openWindow() {
  const { [WINDOW_KEY]: winId } = await chrome.storage.session.get(WINDOW_KEY);
  if (winId != null) {
    try {
      await chrome.windows.update(winId, { focused: true });
      window.close();
      return;
    } catch {}
  }
  await chrome.windows.create({
    url: chrome.runtime.getURL("app.html") + "?mode=window",
    type: "popup",
    focused: true,
    width: 580,
    height: 780,
  });
  window.close();
}

async function liveStatus() {
  const { [JOB_KEY]: st } = await chrome.storage.session.get(JOB_KEY);
  if (!st || !st.running) return null;
  try {
    await chrome.windows.get(st.windowId); // 窗口没了，任务也就没了，别报个假的"正在跑"
  } catch {
    return null;
  }
  return st;
}

for (const [key, item] of Object.entries(scopeInputs)) {
  item.el.addEventListener("change", () => {
    chrome.storage.local.set({ [key]: item.value(item.el) }, () => {
      // 清单可能长达几 MB，装不下时必须说清楚，不能默默丢掉
      if (chrome.runtime.lastError) {
        setStatus(
          key === "siteList"
            ? "这份清单太长，扩展自己的存储装不下（上限约 10MB），所以没帮你记住；这次还是按框里的内容跑。"
            : "这个设置没能存下来：" + chrome.runtime.lastError.message,
          true
        );
      }
    });
  });
}

chrome.storage.local.get(Object.keys(scopeInputs), (saved) => {
  for (const [key, item] of Object.entries(scopeInputs)) {
    if (saved[key] !== undefined) item.apply(item.el, saved[key]);
  }
});

// 网站数据要搬哪几样：两个都没勾就报一句，不开工
function pickedKinds() {
  const kinds = { ls: el("wantLocalStorage").checked, idb: el("wantIndexedDB").checked };
  if (kinds.ls || kinds.idb) return kinds;
  setStatus("先勾出要搬哪几样：LocalStorage 或 IndexedDB，至少勾一个，不然这个按钮不干活。", true);
  return null;
}

if (MODE === "window") {
  myWindowId = (await chrome.windows.getCurrent()).id;
  await chrome.storage.session.set({ [WINDOW_KEY]: myWindowId });

  // 浏览器要关这个窗口时给一句提醒：任务在这儿跑，窗口一关就前功尽弃
  addEventListener("beforeunload", (e) => {
    if (!busy) return;
    e.preventDefault();
    e.returnValue = "还有任务在跑，关掉这个窗口它就中止了。";
  });

  el("cancel").addEventListener("click", () => {
    cancelRequested = true;
    setStatus("正在中止……已经跑完的网站都保住了。", false);
  });
  el("exportBtn").addEventListener("click", () => withJob("导出 Cookies", runCookieExport));
  el("importBtn").addEventListener("click", () =>
    withJob("导入 Cookies", async () => {
      const text = await readPickedJson("Cookies 备份");
      if (text !== null) await runCookieImport(text);
    })
  );
  el("exportDataBtn").addEventListener("click", () => {
    const kinds = pickedKinds();
    if (!kinds) return;
    withJob("导出网站数据", () =>
      runExport({
        useBrowserList: scopeInputs.useBrowserList.el.checked,
        manualText: scopeInputs.siteList.el.value,
        kinds,
      })
    );
  });
  el("importDataBtn").addEventListener("click", () => {
    const kinds = pickedKinds();
    if (!kinds) return;
    withJob("导入网站数据", () => runImport(kinds));
  });
} else {
  // 弹窗只是一个入口：挑文件、搬数据都得在独立窗口里点，弹窗一眨眼就被浏览器收走了
  el("detach").addEventListener("click", openWindow);

  async function refreshLive() {
    const st = await liveStatus();
    el("live").hidden = !st;
    if (st) el("liveText").textContent = `独立窗口正在${st.label || "干活"}：${fmtNum(st.done)} / ${fmtNum(st.total || 0)}`;
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[JOB_KEY]) refreshLive();
  });
  el("live").addEventListener("click", openWindow);
  refreshLive();
}
