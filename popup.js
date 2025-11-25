// 弹窗脚本：用于一键导出 / 导入全部 Cookie 的简单界面

function setStatus(text, isError) {
  const el = document.getElementById("status");
  el.textContent = text || "";
  el.style.color = isError ? "#c00" : "#333";
}

// 绑定导出按钮
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

// 绑定导入按钮：点击时触发隐藏的文件选择框
document.getElementById("importBtn").addEventListener("click", () => {
  const input = document.getElementById("fileInput");
  if (input) {
    input.click();
  }
});

// 监听隐藏的文件选择框变化，执行实际的导入逻辑
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
