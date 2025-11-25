// 后台 service worker：负责导出 / 导入 Cookie 的主要逻辑

// 从 cookie 对象构造用于 chrome.cookies.set 的 URL
function buildCookieUrl(cookie) {
  const protocol = cookie.secure ? "https://" : "http://";

  // 对于大多数情况，cookie.domain 都会有值；如果没有，就没法构造 URL，直接返回 null。
  let host = cookie.domain;
  if (!host || typeof host !== "string") {
    return null;
  }

  // 对于域名级别的 cookie，Chrome 返回的 domain 通常以点开头；
  // 但在 URL 里不能带这个点。
  if (host.startsWith(".")) {
    host = host.slice(1);
  }

  const path = cookie.path || "/";
  return protocol + host + path;
}

async function exportAllCookies() {
  return new Promise((resolve, reject) => {
    chrome.cookies.getAll({}, (cookies) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }

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
          session: c.session
        }))
      };

      try {
        const json = JSON.stringify(payload, null, 2);
        // MV3 service worker 环境里没有 URL.createObjectURL，这里改用 data: URL 方案
        const url =
          "data:application/json;charset=utf-8," + encodeURIComponent(json);

        const timestamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-");

        chrome.downloads.download(
          {
            url,
            filename: `cookies-export-${timestamp}.json`,
            saveAs: true
          },
          (downloadId) => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
            } else {
              resolve({ total: cookies.length, downloadId });
            }
          }
        );
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function importAllCookies(importData) {
  if (
    !importData ||
    importData.format !== "cookie-transfer-v1" ||
    !Array.isArray(importData.cookies)
  ) {
    // 基本格式校验失败，说明导入的 JSON 结构不符合预期
    throw new Error("无效的 Cookie 导入格式");
  }

  const cookies = importData.cookies;
  let success = 0;
  let failed = 0;

  for (const c of cookies) {
    try {
      const url = buildCookieUrl(c);
      if (!url) {
        failed += 1;
        continue;
      }

      const details = {
        url,
        name: c.name,
        value: c.value,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly
      };

      // 某些 Chrome 版本的 sameSite 会返回 "unspecified"，这在 set 的时候可能是非法值；
      // 这里只在值是标准的 "no_restriction" | "lax" | "strict" 时才带上。
      if (
        c.sameSite === "no_restriction" ||
        c.sameSite === "lax" ||
        c.sameSite === "strict"
      ) {
        details.sameSite = c.sameSite;
      }

      // 不再强行带上 storeId，否则跨浏览器 / 跨配置文件时会因为 storeId 不存在而全部失败。

      // 对非 hostOnly 的 cookie 才设置 domain；hostOnly 由 url 自动推导。
      if (!c.hostOnly && c.domain) {
        details.domain = c.domain;
      }

      // 只有非 session 的 cookie 才设置过期时间。
      if (!c.session && c.expirationDate) {
        details.expirationDate = c.expirationDate;
      }

      await new Promise((resolveSet, rejectSet) => {
        chrome.cookies.set(details, (result) => {
          if (chrome.runtime.lastError || !result) {
            rejectSet(chrome.runtime.lastError || new Error("Unknown error"));
          } else {
            resolveSet();
          }
        });
      });

      success += 1;
    } catch (e) {
      failed += 1;
    }
  }

  return { total: cookies.length, success, failed };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { type } = message || {};

  if (type === "exportCookies") {
    exportAllCookies()
      .then((result) => {
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }

  if (type === "importCookies") {
    importAllCookies(message.data)
      .then((result) => {
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }

  return false;
});
