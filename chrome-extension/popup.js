import { buildCloudDockUrl, loadRules, matchPageUrl } from "./rules.js";

const urlElement = document.querySelector("#current-url");
const statusElement = document.querySelector("#status");
const openButton = document.querySelector("#open");
const optionsButton = document.querySelector("#options");

let activeTab = null;
let matchedUrl = null;

async function initialize() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  urlElement.textContent = activeTab?.url || "无法读取当前页面";
  const result = matchPageUrl(activeTab?.url || "", await loadRules());
  if (!result.ok) {
    statusElement.textContent = result.reason;
    return;
  }
  matchedUrl = result.url;
  statusElement.textContent = `匹配规则：${result.rule.host}${result.rule.pathPrefix}`;
  statusElement.classList.add("success");
  openButton.disabled = false;
}

openButton.addEventListener("click", async () => {
  if (!activeTab?.id || !matchedUrl) return;
  openButton.disabled = true;
  try {
    await chrome.tabs.update(activeTab.id, { url: buildCloudDockUrl(matchedUrl) });
    window.close();
  } catch {
    statusElement.textContent = "Chrome 未能启动 CloudDock，请确认已安装应用并允许打开外部协议";
    statusElement.classList.remove("success");
    openButton.disabled = false;
  }
});

optionsButton.addEventListener("click", () => void chrome.runtime.openOptionsPage());

void initialize().catch((error) => {
  statusElement.textContent = error instanceof Error ? error.message : "扩展初始化失败";
});
