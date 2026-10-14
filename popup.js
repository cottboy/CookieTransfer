// 弹窗脚本：一键导出 / 导入 Cookie，以及一键导出 / 导入各网站的本地存储和数据库

function setStatus(text, isError) {
  const el = document.getElementById("status");
  el.textContent = text || "";
  el.style.color = isError ? "#c00" : "#333";
}

function describeExport(res) {
  return [
    `导出完成：${res.sites} 个网站有数据。`,
    `本地存储 ${res.localStorageKeys} 条，数据库 ${res.databases} 个（${res.records} 条记录）。`,
    res.blobBytes ? `其中文件类数据约 ${(res.blobBytes / 1048576).toFixed(1)} MB。` : "",
    res.failedCount ? `有 ${res.failedCount} 项没能处理，详情已记在备份文件里。` : "",
    `文件名叫 ${res.filename}，正在等你选保存位置。`
  ]
    .filter(Boolean)
    .join(" ");
}

function describeImport(res) {
  return [
    `导入完成：写回了 ${res.sites} 个网站。`,
    `本地存储 ${res.localStorageKeys} 条，数据库 ${res.databases} 个（${res.records} 条记录）。`,
    res.failedCount ? `有 ${res.failedCount} 项没成功。` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

// ---------- Cookie ----------

document.getElementById("exportBtn").addEventListener("click", () => {
  setStatus("正在导出全部 Cookies，请稍候……", false);

  chrome.runtime.sendMessage({ type: "exportCookies" }, (res) => {
    if (!res || !res.ok) {
      setStatus("导出失败：" + (res && res.error ? res.error : "未知错误"), true);
      return;
    }

    setStatus(`导出成功，共导出 ${res.total} 个 Cookie，已保存为文件。`, false);
  });
});

document.getElementById("importBtn").addEventListener("click", () => {
  const input = document.getElementById("fileInput");
  if (input) {
    input.click();
  }
});

document.getElementById("fileInput").addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];

  if (!file) {
    return;
  }

  setStatus("正在读取文件并导入 Cookies……", false);

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);

      chrome.runtime.sendMessage(
        { type: "importCookies", data },
        (res) => {
          if (!res || !res.ok) {
            setStatus(
              "导入失败：" + (res && res.error ? res.error : "未知错误"),
              true
            );
            return;
          }

          setStatus(
            `导入完成，总计 ${res.total} 个，成功 ${res.success} 个，失败 ${res.failed} 个。`,
            false
          );
        }
      );
    } catch (e) {
      setStatus("文件格式错误，无法解析为 JSON：" + String(e), true);
    }
  };

  reader.onerror = () => {
    setStatus("读取文件时发生错误。", true);
  };

  reader.readAsText(file, "utf-8");
});

// ---------- 网站数据（本地存储 + IndexedDB）----------

// 把选好的范围记下来，下次打开弹窗还在
const scopeInputs = {
  useBrowserList: document.getElementById("useBrowserList"),
  siteList: document.getElementById("siteList"),
};

chrome.storage.local.get(["useBrowserList", "siteList"], (saved) => {
  if (saved.useBrowserList !== undefined) scopeInputs.useBrowserList.checked = saved.useBrowserList;
  if (saved.siteList !== undefined) scopeInputs.siteList.value = saved.siteList;
});

for (const [key, el] of Object.entries(scopeInputs)) {
  el.addEventListener("change", () => {
    chrome.storage.local.set({
      [key]: key === "siteList" ? el.value : el.checked,
    });
  });
}

// 处理页干活时不看弹窗，所以它报的进度和结果直接收下来显示
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !String(msg.type).startsWith("siteData:")) return;

  if (msg.type === "siteData:progress") {
    const action = msg.phase === "import" ? "导入" : "导出";
    setStatus(`正在${action}网站数据 ${msg.done}/${msg.total}：${msg.current}`, false);
  } else if (msg.type === "siteData:done") {
    if (!msg.ok) {
      setStatus("失败：" + msg.error, true);
    } else if (msg.phase === "import") {
      setStatus(describeImport(msg), false);
    } else {
      setStatus(describeExport(msg), false);
    }
  }
});

// 先把那个最小化的处理页开起来，它才有力气干活
async function startEngine() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "ensureEngine" }, (res) => {
      if (!res || !res.ok) {
        setStatus("打不开处理页：" + (res && res.error ? res.error : "未知错误"), true);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

document.getElementById("exportDataBtn").addEventListener("click", async () => {
  setStatus("准备中，正在打开处理页……", false);
  if (!(await startEngine())) return;

  setStatus("正在清点要处理的网站……", false);
  chrome.runtime.sendMessage({
    type: "siteData:run",
    op: "export",
    payload: {
      useBrowserList: scopeInputs.useBrowserList.checked,
      manualText: scopeInputs.siteList.value,
    },
  });
});

document.getElementById("importDataBtn").addEventListener("click", () => {
  const input = document.getElementById("dataFileInput");
  if (input) {
    input.click();
  }
});

function bytesToB64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// 备份文件可能很大，切成小块一份份送给处理页，别想一口吞下
async function sendFileToEngine(file) {
  const CHUNK = 4 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    const buffer = await file.slice(offset, offset + CHUNK).arrayBuffer();
    await chrome.runtime.sendMessage({
      type: "siteData:file",
      data: bytesToB64(buffer),
    });
    setStatus(`正在读取备份文件 ${Math.round(((offset + CHUNK) / file.size) * 100)}%……`, false);
  }
}

document.getElementById("dataFileInput").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  setStatus("准备中，正在打开处理页……", false);
  if (!(await startEngine())) return;

  try {
    await sendFileToEngine(file);
  } catch (e) {
    setStatus("读取备份文件失败：" + String(e), true);
    return;
  }

  setStatus("文件读完了，正在写回各网站……", false);
  chrome.runtime.sendMessage({ type: "siteData:run", op: "import" });
});
