import { buildCloudDockUrl, loadRules, matchPageUrl } from "./rules.js";

const MENU_ID = "open-in-clouddock";

async function installMenu() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "在 CloudDock 中打开此页",
    contexts: ["page"],
    documentUrlPatterns: ["https://*/*"],
  });
}

async function showFailure(reason) {
  await chrome.action.setBadgeBackgroundColor({ color: "#b42318" });
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setTitle({ title: reason });
  setTimeout(() => {
    void chrome.action.setBadgeText({ text: "" });
    void chrome.action.setTitle({ title: "在 CloudDock 中打开" });
  }, 4_000);
}

async function openTab(tab) {
  if (!tab?.id || !tab.url) {
    await showFailure("无法读取当前页面地址");
    return;
  }
  const result = matchPageUrl(tab.url, await loadRules());
  if (!result.ok) {
    await showFailure(result.reason);
    return;
  }
  try {
    await chrome.tabs.update(tab.id, { url: buildCloudDockUrl(result.url) });
  } catch {
    await showFailure("Chrome 未能启动 CloudDock，请确认应用安装与外部协议授权");
  }
}

chrome.runtime.onInstalled.addListener(() => void installMenu());
chrome.runtime.onStartup.addListener(() => void installMenu());
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) void openTab(tab);
});
