import { normalizeConsoleUrl, parseConsoleTarget } from "../../../shared/console-url";
import type { TaskStatus, WorkspaceSnapshot, WorkspaceTab } from "../../../shared/model";
import {
  getProductContextLabel,
  getTabDisplayTitle,
  productLabel,
} from "../../../shared/workspace-display";

const TASK_STATUS_LABELS: Record<TaskStatus | "none", string> = {
  todo: "待处理",
  doing: "处理中",
  done: "已完成",
  none: "未标记",
};

function shareableUrl(tab: WorkspaceTab): string | null {
  if (tab.isAuthenticating || tab.externalHostname || !parseConsoleTarget(tab.url)) return null;
  return normalizeConsoleUrl(tab.url);
}

function filteredTaskQueue(snapshot: WorkspaceSnapshot): WorkspaceTab[] {
  return snapshot.tabs.filter((tab) =>
    tab.id === snapshot.activeTabId
    || (
      (snapshot.productFilter === "all" || tab.product === snapshot.productFilter)
      && (snapshot.taskFilter === "all" || (tab.taskStatus ?? "none") === snapshot.taskFilter)
    ));
}

export function formatWorkspaceContext(snapshot: WorkspaceSnapshot): string {
  const active = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);
  if (!active) throw new Error("当前没有可复制的工作区页面");

  const activeUrl = shareableUrl(active);
  if (!activeUrl) throw new Error("登录或外部页面不能复制工作区上下文");

  const productFilter = snapshot.productFilter === "all"
    ? "全部产品"
    : productLabel(snapshot.productFilter);
  const taskFilter = snapshot.taskFilter === "all"
    ? "全部任务状态"
    : TASK_STATUS_LABELS[snapshot.taskFilter];
  const queue = filteredTaskQueue(snapshot);
  const queueLines = queue.length === 0
    ? ["- 无"]
    : queue.map((tab) => {
        const url = shareableUrl(tab);
        const suffix = url ? ` | ${url}` : "";
        return `- [${TASK_STATUS_LABELS[tab.taskStatus ?? "none"]}] ${getTabDisplayTitle(tab)} | ${getProductContextLabel(tab.product, tab.regionId)}${suffix}`;
      });

  return [
    "CloudDock 工作区上下文",
    `当前页面：${getTabDisplayTitle(active)}`,
    `模块：${getProductContextLabel(active.product, active.regionId)}`,
    `链接：${activeUrl}`,
    `筛选：${productFilter} / ${taskFilter}`,
    `任务队列（${queue.length}）：`,
    ...queueLines,
  ].join("\n");
}
