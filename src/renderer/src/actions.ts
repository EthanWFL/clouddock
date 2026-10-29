import type {
  Favorite,
  ModuleShortcut,
  Product,
  TaskFilter,
  WorkspaceCommand,
  WorkspaceTab,
} from "../../shared/model";
import type { ViewAction } from "../../shared/ipc";
import type { GlobalProductEntry } from "../../shared/workspace-display";
import { useRendererStore } from "./store";

export type TabTaskFilter = TaskFilter;

export function filterTabsForQueue(
  tabs: readonly WorkspaceTab[],
  activeTabId: string | null,
  productFilter: Product | "all",
  taskFilter: TabTaskFilter,
): WorkspaceTab[] {
  return tabs.filter((tab) =>
    tab.id === activeTabId
    || (
      (productFilter === "all" || tab.product === productFilter)
      && (taskFilter === "all" || (tab.taskStatus ?? "none") === taskFilter)
    ));
}

export async function runWorkspaceAction(
  command: WorkspaceCommand,
  fallback = "操作失败，请重试",
): Promise<boolean> {
  const { setActionError } = useRendererStore.getState();
  setActionError(null);
  try {
    const result = await window.opsdock.dispatch(command);
    if (!result.ok) setActionError(result.error);
    return result.ok;
  } catch {
    setActionError(fallback);
    return false;
  }
}

export async function runViewAction(action: ViewAction): Promise<boolean> {
  const { setActionError } = useRendererStore.getState();
  setActionError(null);
  try {
    await window.opsdock.performViewAction(action);
    return true;
  } catch {
    setActionError("控制台操作失败，请重试");
    return false;
  }
}

export function openGlobalProductEntry(entry: GlobalProductEntry): Promise<boolean> {
  return entry.url
    ? runWorkspaceAction({
        type: "open-url",
        product: entry.product,
        regionId: null,
        url: entry.url,
        title: entry.label,
      })
    : runWorkspaceAction({ type: "open-entry", product: entry.product, regionId: null });
}

export async function copyDiagnostics(): Promise<void> {
  const { setActionError } = useRendererStore.getState();
  setActionError(null);
  try {
    await window.opsdock.copyDiagnostics();
  } catch {
    setActionError("诊断摘要复制失败，请重试");
  }
}

export async function removeFavoriteWithUndo(favorite: Favorite): Promise<void> {
  const removed = await runWorkspaceAction({
    type: "remove-favorite",
    favoriteId: favorite.id,
  });
  if (removed) useRendererStore.getState().setRemovedFavorite(favorite);
}

export async function removeModuleShortcutWithUndo(shortcut: ModuleShortcut): Promise<void> {
  const removed = await runWorkspaceAction({
    type: "remove-module-shortcut",
    shortcutId: shortcut.id,
  });
  if (removed) useRendererStore.getState().setRemovedModuleShortcut(shortcut);
}

export async function completeActiveTabAndAdvance(): Promise<boolean> {
  const state = useRendererStore.getState();
  const snapshot = state.snapshot;
  if (!snapshot?.activeTabId) return false;

  const activeTabId = snapshot.activeTabId;
  const queue = filterTabsForQueue(
    snapshot.tabs,
    activeTabId,
    snapshot.productFilter,
    snapshot.taskFilter,
  ).filter((tab) => tab.id === activeTabId || tab.taskStatus !== "done");
  const activeIndex = queue.findIndex((tab) => tab.id === activeTabId);
  const nextTab = queue.length > 1
    ? queue[(activeIndex < 0 ? 0 : activeIndex + 1) % queue.length]
    : undefined;

  const completed = await runWorkspaceAction({
    type: "set-tab-task-status",
    tabId: activeTabId,
    taskStatus: "done",
  });
  if (!completed || !nextTab || nextTab.id === activeTabId) return completed;
  return runWorkspaceAction({ type: "activate-tab", tabId: nextTab.id });
}

export async function copyWorkspaceContext(): Promise<void> {
  const { setActionError } = useRendererStore.getState();
  setActionError(null);
  try {
    await window.opsdock.copyWorkspaceContext();
  } catch {
    setActionError("工作区上下文复制失败，请重试");
  }
}

export async function retryFailedTabs(): Promise<void> {
  const { setActionError } = useRendererStore.getState();
  setActionError(null);
  try {
    await window.opsdock.retryFailedTabs();
  } catch {
    setActionError("失败标签重试失败，请稍后再试");
  }
}
