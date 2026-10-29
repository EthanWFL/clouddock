import { Command } from "cmdk";
import {
  Bookmark,
  CheckCircle2,
  CircleDot,
  CircleOff,
  ClipboardCopy,
  Clock3,
  Copy,
  ExternalLink,
  History,
  Link,
  Pin,
  RotateCcw,
  Search,
  Star,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { extractConsoleUrls, normalizeConsoleUrl, parseConsoleTarget } from "../../shared/console-url";
import type { Product, TaskStatus, WorkspaceCommand, WorkspaceTab } from "../../shared/model";
import { getRegionShortName } from "../../shared/regions";
import {
  getProductContextLabel,
  getProductRegionIds,
  getTabDisplayTitle,
  GLOBAL_PRODUCT_ENTRIES,
  productLabel,
  REGIONAL_PRODUCTS,
} from "../../shared/workspace-display";
import {
  completeActiveTabAndAdvance,
  copyWorkspaceContext,
  filterTabsForQueue,
  openGlobalProductEntry,
  removeFavoriteWithUndo,
  retryFailedTabs,
  runViewAction,
  runWorkspaceAction,
} from "./actions";
import { ConsoleEntryIcon, ProductIcon } from "./ProductIcon";
import { useRendererStore } from "./store";

const TASK_STATUS_OPTIONS: ReadonlyArray<{
  value: TaskStatus;
  label: string;
  icon: typeof CircleDot;
}> = [
  { value: "todo", label: "待处理", icon: CircleDot },
  { value: "doing", label: "处理中", icon: Clock3 },
  { value: "done", label: "已完成", icon: CheckCircle2 },
];

const TASK_STATUS_PRIORITY: Record<TaskStatus | "none", number> = {
  doing: 0,
  todo: 1,
  none: 2,
  done: 3,
};

interface TabActionSpec {
  id: "pin" | "unpin" | TaskStatus | "clear" | "close";
  label: string;
  aliases: readonly string[];
  icon: typeof CircleDot;
  applies: (tab: WorkspaceTab) => boolean;
  command: (tab: WorkspaceTab) => WorkspaceCommand;
}

const TAB_ACTIONS: readonly TabActionSpec[] = [
  {
    id: "unpin",
    label: "取消固定",
    aliases: ["取消固定", "unpin"],
    icon: Pin,
    applies: (tab) => tab.pinned,
    command: (tab) => ({ type: "set-tab-pinned", tabId: tab.id, pinned: false }),
  },
  {
    id: "pin",
    label: "固定",
    aliases: ["固定", "pin"],
    icon: Pin,
    applies: (tab) => !tab.pinned,
    command: (tab) => ({ type: "set-tab-pinned", tabId: tab.id, pinned: true }),
  },
  {
    id: "todo",
    label: "标记为待处理",
    aliases: ["待处理", "todo"],
    icon: CircleDot,
    applies: (tab) => tab.taskStatus !== "todo",
    command: (tab) => ({ type: "set-tab-task-status", tabId: tab.id, taskStatus: "todo" }),
  },
  {
    id: "doing",
    label: "标记为处理中",
    aliases: ["处理中", "doing"],
    icon: Clock3,
    applies: (tab) => tab.taskStatus !== "doing",
    command: (tab) => ({ type: "set-tab-task-status", tabId: tab.id, taskStatus: "doing" }),
  },
  {
    id: "done",
    label: "标记为已完成",
    aliases: ["已完成", "done"],
    icon: CheckCircle2,
    applies: (tab) => tab.taskStatus !== "done",
    command: (tab) => ({ type: "set-tab-task-status", tabId: tab.id, taskStatus: "done" }),
  },
  {
    id: "clear",
    label: "清除任务状态",
    aliases: ["清除状态", "未标记", "clear"],
    icon: CircleOff,
    applies: (tab) => tab.taskStatus !== null,
    command: (tab) => ({ type: "set-tab-task-status", tabId: tab.id, taskStatus: null }),
  },
  {
    id: "close",
    label: "关闭",
    aliases: ["关闭", "close"],
    icon: X,
    applies: () => true,
    command: (tab) => ({ type: "close-tab", tabId: tab.id }),
  },
];

function parseTabActionQuery(query: string): TabActionSpec | null {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return null;
  return TAB_ACTIONS.find((action) => action.aliases.some((alias) =>
    normalized.startsWith(`${alias}:`) || normalized.startsWith(`${alias}：`))) ?? null;
}

function comparePaletteTabs(
  left: WorkspaceTab,
  right: WorkspaceTab,
  activeTabId: string | null,
): number {
  const activeDifference = Number(right.id === activeTabId) - Number(left.id === activeTabId);
  if (activeDifference !== 0) return activeDifference;
  const pinnedDifference = Number(right.pinned) - Number(left.pinned);
  if (pinnedDifference !== 0) return pinnedDifference;
  const taskDifference = TASK_STATUS_PRIORITY[left.taskStatus ?? "none"]
    - TASK_STATUS_PRIORITY[right.taskStatus ?? "none"];
  if (taskDifference !== 0) return taskDifference;
  return right.lastActiveAt - left.lastActiveAt;
}

function getTabLocationLabel(urlValue: string): string {
  try {
    const url = new URL(urlValue);
    const hashPath = url.hash.replace(/^#\/?/, "").split("?", 1)[0];
    const path = hashPath || url.pathname.replace(/^\/+/, "");
    return path ? `${url.hostname}/${path}` : url.hostname;
  } catch {
    return urlValue;
  }
}

function getTabMetadata(tab: WorkspaceTab, activeTabId: string | null): string {
  const taskStatus = TASK_STATUS_OPTIONS.find((option) => option.value === tab.taskStatus)?.label;
  return [
    tab.id === activeTabId ? "当前" : null,
    tab.pinned ? "固定" : null,
    taskStatus,
    getProductContextLabel(tab.product, tab.regionId),
    getTabLocationLabel(tab.url),
  ].filter(Boolean).join(" · ");
}

export default function CommandPalette() {
  const snapshot = useRendererStore((state) => state.snapshot)!;
  const commandMode = useRendererStore((state) => state.commandMode);
  const closeCommand = useRendererStore((state) => state.closeCommand);
  const setFavoriteEditor = useRendererStore((state) => state.setFavoriteEditor);
  const setModuleShortcutEditor = useRendererStore((state) => state.setModuleShortcutEditor);
  const open = commandMode !== null;
  const [query, setQuery] = useState("");
  const hasQuery = query.trim().length > 0;
  const requestedAction = parseTabActionQuery(query);
  const directUrls = useMemo(
    () => requestedAction ? [] : extractConsoleUrls(query),
    [query, requestedAction],
  );
  const paletteTabs = useMemo(
    () => [...snapshot.tabs].sort((left, right) =>
      comparePaletteTabs(left, right, snapshot.activeTabId)),
    [snapshot.activeTabId, snapshot.tabs],
  );

  const openTabUrls = useMemo(() => new Set(snapshot.tabs.map((tab) => {
    try {
      return normalizeConsoleUrl(tab.url);
    } catch {
      return tab.url;
    }
  })), [snapshot.tabs]);
  const recentVisitsByProduct = useMemo(() => {
    const groups = new Map<Product, typeof snapshot.recentVisits>();
    for (const visit of snapshot.recentVisits) {
      let normalized: string;
      try {
        normalized = normalizeConsoleUrl(visit.url);
      } catch {
        continue;
      }
      if (openTabUrls.has(normalized)) continue;
      const visits = groups.get(visit.product) ?? [];
      if (hasQuery || visits.length < 5) groups.set(visit.product, [...visits, visit]);
    }
    return groups;
  }, [hasQuery, openTabUrls, snapshot.recentVisits]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    setQuery("");
    if (commandMode !== "link-opener") return;
    let cancelled = false;
    void window.opsdock.getClipboardConsoleUrls().then((urls) => {
      if (!cancelled && urls.length > 0) setQuery((current) => current || urls.join("\n"));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [commandMode, open]);

  const run = (action: () => unknown | Promise<unknown>) => {
    closeCommand();
    void action();
  };

  const activeTab = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);
  const activeTarget = activeTab ? parseConsoleTarget(activeTab.url) : null;
  const activeFavorite = activeTab
    ? snapshot.favorites.find((favorite) =>
        normalizeConsoleUrl(favorite.url) === normalizeConsoleUrl(activeTab.url))
    : undefined;
  const canUseActiveUrl = Boolean(activeTab && !activeTab.isAuthenticating && !activeTab.externalHostname && activeTarget);
  const otherTabCount = activeTab ? snapshot.tabs.length - 1 : 0;
  const completedTabCount = snapshot.tabs.filter((tab) => tab.taskStatus === "done").length;
  const unpinnedTabCount = snapshot.tabs.filter((tab) => !tab.pinned).length;
  const failedTabCount = snapshot.tabs.filter(
    (tab) => tab.loadState === "error" || tab.loadState === "crashed",
  ).length;
  const activeQueue = activeTab
    ? filterTabsForQueue(
        snapshot.tabs,
        activeTab.id,
        snapshot.productFilter,
        snapshot.taskFilter,
      ).filter((tab) => tab.id === activeTab.id || tab.taskStatus !== "done")
    : [];
  const activeQueueIndex = activeTab
    ? activeQueue.findIndex((tab) => tab.id === activeTab.id)
    : -1;
  const nextActiveTab = activeQueue.length > 1
    ? activeQueue[(activeQueueIndex < 0 ? 0 : activeQueueIndex + 1) % activeQueue.length]
    : undefined;

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeCommand();
      }}
      label="快速切换"
      className="command-dialog"
    >
      <div className="command-overlay" />
      <div className="command-panel">
        <div className="command-input-wrap">
          <Search size={17} />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="搜索标签或操作，或粘贴控制台链接"
          />
          <kbd>esc</kbd>
        </div>
        <Command.List>
          <Command.Empty>没有匹配项</Command.Empty>
          {!requestedAction && snapshot.tabs.length > 0 && (
            <Command.Group heading="打开的标签">
              {paletteTabs.map((tab) => {
                const metadata = getTabMetadata(tab, snapshot.activeTabId);
                return (
                  <Command.Item
                    data-product={tab.product}
                    key={tab.id}
                    value={`tab:${tab.id}`}
                    keywords={[tab.title, getTabDisplayTitle(tab), metadata, tab.url]}
                    onSelect={() => run(() => runWorkspaceAction({ type: "activate-tab", tabId: tab.id }))}
                  >
                    <ProductIcon product={tab.product} />
                    <span>{getTabDisplayTitle(tab)}</span>
                    <small title={metadata}>{metadata}</small>
                  </Command.Item>
                );
              })}
            </Command.Group>
          )}
          {!requestedAction && (
            <Command.Group heading="常用操作">
              {activeTab && activeTab.taskStatus !== "done" && (
                <Command.Item
                  value="action:complete-and-advance"
                  keywords={["完成当前并切到下一条", "完成并继续", "done next", activeTab.title]}
                  onSelect={() => run(completeActiveTabAndAdvance)}
                >
                  <CheckCircle2 size={16} />
                  <span>完成当前并切到下一条</span>
                  <small>{nextActiveTab ? getTabDisplayTitle(nextActiveTab) : "仅标记当前"}</small>
                </Command.Item>
              )}
              {activeTab && (activeFavorite || canUseActiveUrl) && (
                <Command.Item
                  value={activeFavorite ? "action:remove-favorite" : "action:add-favorite"}
                  keywords={activeFavorite
                    ? ["取消收藏", "remove favorite", activeTab.title]
                    : ["收藏当前页面", "favorite", activeTab.title]}
                  onSelect={() => {
                    if (activeFavorite) run(() => removeFavoriteWithUndo(activeFavorite));
                    else run(() => setFavoriteEditor(true));
                  }}
                >
                  <Star size={16} fill={activeFavorite ? "currentColor" : "none"} />
                  <span>{activeFavorite ? "取消收藏当前页面" : "收藏当前页面"}</span>
                  <small>{getTabDisplayTitle(activeTab)}</small>
                </Command.Item>
              )}
              {canUseActiveUrl
                && activeTab
                && (activeTab.product === "codeup" || activeTab.product === "sls") && (
                <Command.Item
                  value="action:add-module-shortcut"
                  keywords={["保存模块快捷入口", "shortcut", activeTab.title]}
                  onSelect={() => run(() => setModuleShortcutEditor(true))}
                >
                  <Bookmark size={16} />
                  <span>保存模块快捷入口</span>
                  <small>{getTabDisplayTitle(activeTab)}</small>
                </Command.Item>
              )}
              {canUseActiveUrl && (
                <>
                  <Command.Item
                    value="action:copy-link"
                    keywords={["复制当前链接", "copy link"]}
                    onSelect={() => run(() => runViewAction({ type: "copy-link" }))}
                  >
                    <Copy size={16} />
                    <span>复制当前链接</span>
                    <small>当前标签</small>
                  </Command.Item>
                  <Command.Item
                    value="action:open-system"
                    keywords={["用默认浏览器打开", "browser"]}
                    onSelect={() => run(() => runViewAction({ type: "open-system" }))}
                  >
                    <ExternalLink size={16} />
                    <span>用默认浏览器打开</span>
                    <small>当前标签</small>
                  </Command.Item>
                </>
              )}
              {canUseActiveUrl && (
                <Command.Item
                  value="action:copy-workspace-context"
                  keywords={["复制工作区上下文", "复制任务队列", "copy workspace context"]}
                  onSelect={() => run(copyWorkspaceContext)}
                >
                  <ClipboardCopy size={16} />
                  <span>复制工作区上下文</span>
                  <small>当前页面与筛选队列</small>
                </Command.Item>
              )}
              {failedTabCount > 0 && (
                <Command.Item
                  value="action:retry-failed-tabs"
                  keywords={["重试失败标签", "恢复崩溃页面", "retry failed tabs"]}
                  onSelect={() => run(retryFailedTabs)}
                >
                  <RotateCcw size={16} />
                  <span>顺序重试失败标签</span>
                  <small>{failedTabCount} 个</small>
                </Command.Item>
              )}
              {otherTabCount > 0 && (
                <Command.Item
                  value="action:close-other-tabs"
                  keywords={["关闭其他标签", "close others"]}
                  onSelect={() => run(() => runWorkspaceAction({ type: "close-tabs", scope: "others" }))}
                >
                  <X size={16} />
                  <span>关闭其他标签</span>
                  <small>{otherTabCount} 个</small>
                </Command.Item>
              )}
              {completedTabCount > 0 && (
                <Command.Item
                  value="action:close-completed-tabs"
                  keywords={["关闭已完成标签", "close completed"]}
                  onSelect={() => run(() => runWorkspaceAction({ type: "close-tabs", scope: "completed" }))}
                >
                  <CheckCircle2 size={16} />
                  <span>关闭已完成标签</span>
                  <small>{completedTabCount} 个</small>
                </Command.Item>
              )}
              {unpinnedTabCount > 0 && (
                <Command.Item
                  value="action:close-unpinned-tabs"
                  keywords={["关闭未固定标签", "close unpinned"]}
                  onSelect={() => run(() => runWorkspaceAction({ type: "close-tabs", scope: "unpinned" }))}
                >
                  <Pin size={16} />
                  <span>关闭未固定标签</span>
                  <small>{unpinnedTabCount} 个</small>
                </Command.Item>
              )}
            </Command.Group>
          )}
          {requestedAction && (
            <Command.Group heading="标签操作">
              {paletteTabs.filter(requestedAction.applies).map((tab) => {
                const metadata = getTabMetadata(tab, snapshot.activeTabId);
                const ActionIcon = requestedAction.icon;
                return (
                  <Command.Item
                    key={`${requestedAction.id}:${tab.id}`}
                    value={`tab-action:${requestedAction.id}:${tab.id}`}
                    keywords={[
                      ...requestedAction.aliases,
                      ...requestedAction.aliases.flatMap((alias) => [
                        `${alias}: ${tab.title}`,
                        `${alias}：${tab.title}`,
                        `${alias}: ${getTabDisplayTitle(tab)}`,
                        `${alias}：${getTabDisplayTitle(tab)}`,
                      ]),
                      requestedAction.label,
                      tab.title,
                      getTabDisplayTitle(tab),
                      metadata,
                      tab.url,
                    ]}
                    onSelect={() => run(() => runWorkspaceAction(requestedAction.command(tab)))}
                  >
                    <ActionIcon
                      size={16}
                      fill={requestedAction.id === "unpin" ? "currentColor" : "none"}
                    />
                    <span>{requestedAction.label} {getTabDisplayTitle(tab)}</span>
                    <small title={metadata}>{metadata}</small>
                  </Command.Item>
                );
              })}
            </Command.Group>
          )}
          {directUrls.length > 0 && (
            <Command.Group forceMount heading="打开链接">
              {directUrls.length > 1 && (
                <Command.Item
                  forceMount
                  value={`open all urls ${query}`}
                  onSelect={() => run(() => runWorkspaceAction({
                    type: "open-pasted-urls",
                    urls: directUrls,
                  }))}
                >
                  <ExternalLink size={16} />
                  <span>打开全部 {directUrls.length} 个链接</span>
                  <small>已去重预览</small>
                </Command.Item>
              )}
              {directUrls.map((url, index) => (
                <Command.Item
                  forceMount
                  key={url}
                  value={`open url ${index} ${query}`}
                  onSelect={() => run(() => runWorkspaceAction({ type: "open-pasted-url", url }))}
                >
                  <Link size={16} />
                  <span title={url}>{url}</span>
                  <small>单独打开</small>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {!requestedAction && snapshot.recentlyClosedTabs.length > 0 && (
            <Command.Group heading="最近关闭">
              {snapshot.recentlyClosedTabs.map((tab) => {
                const metadata = getTabMetadata(tab, null);
                return (
                  <Command.Item
                    data-product={tab.product}
                    key={`closed:${tab.id}`}
                    value={`closed:${tab.id}`}
                    keywords={[
                      tab.title,
                      getTabDisplayTitle(tab),
                      metadata,
                      getTabLocationLabel(tab.url),
                    ]}
                    onSelect={() => run(() => runWorkspaceAction({
                      type: "reopen-closed-tab",
                      tabId: tab.id,
                    }))}
                  >
                    <History size={16} />
                    <span>{getTabDisplayTitle(tab)}</span>
                    <small title={metadata}>{metadata}</small>
                  </Command.Item>
                );
              })}
            </Command.Group>
          )}
          {!requestedAction && snapshot.moduleShortcuts.length > 0 && (
            <Command.Group heading="模块快捷入口">
              {snapshot.moduleShortcuts.map((shortcut) => {
                const location = getTabLocationLabel(shortcut.url);
                const metadata = `${productLabel(shortcut.product)} · ${location}`;
                return (
                  <Command.Item
                    data-product={shortcut.product}
                    key={shortcut.id}
                    value={`shortcut:${shortcut.id}`}
                    keywords={[shortcut.name, productLabel(shortcut.product), location]}
                    onSelect={() => run(() => runWorkspaceAction({
                      type: "open-url",
                      product: shortcut.product,
                      regionId: null,
                      url: shortcut.url,
                      title: shortcut.name,
                    }))}
                  >
                    <Bookmark size={16} />
                    <span>{shortcut.name}</span>
                    <small title={metadata}>{metadata}</small>
                  </Command.Item>
                );
              })}
            </Command.Group>
          )}
          {!requestedAction && snapshot.favorites.length > 0 && (
            <Command.Group heading="收藏">
              {snapshot.favorites.map((favorite) => {
                const location = getTabLocationLabel(favorite.url);
                const metadata = `${getProductContextLabel(favorite.product, favorite.regionId)} · ${location}`;
                return (
                  <Command.Item
                    data-product={favorite.product}
                    key={favorite.id}
                    value={`favorite:${favorite.id}`}
                    keywords={[
                      favorite.name,
                      getProductContextLabel(favorite.product, favorite.regionId),
                      location,
                    ]}
                    onSelect={() => run(() => runWorkspaceAction({
                      type: "open-url",
                      product: favorite.product,
                      regionId: favorite.regionId,
                      url: favorite.url,
                      title: favorite.name,
                    }))}
                  >
                    <Star size={16} />
                    <span>{favorite.name}</span>
                    <small title={metadata}>{metadata}</small>
                  </Command.Item>
                );
              })}
            </Command.Group>
          )}
          {!requestedAction && [...recentVisitsByProduct].map(([product, visits]) => (
            <Command.Group key={product} heading={`最近访问 · ${productLabel(product)}`}>
              {visits.map((visit) => {
                const location = getTabLocationLabel(visit.url);
                const metadata = `${getProductContextLabel(visit.product, visit.regionId)} · ${location}`;
                return (
                  <Command.Item
                    data-product={visit.product}
                    key={`${visit.product}-${visit.url}`}
                    value={`recent:${product}:${snapshot.recentVisits.indexOf(visit)}`}
                    keywords={[
                      visit.title,
                      getProductContextLabel(visit.product, visit.regionId),
                      location,
                    ]}
                    onSelect={() => run(() => runWorkspaceAction({
                      type: "open-url",
                      product: visit.product,
                      regionId: visit.regionId,
                      url: visit.url,
                      title: visit.title,
                    }))}
                  >
                    <History size={16} />
                    <span>{visit.title}</span>
                    <small title={metadata}>{metadata}</small>
                  </Command.Item>
                );
              })}
            </Command.Group>
          ))}
          {!requestedAction && (
            <Command.Group heading="产品入口">
              {REGIONAL_PRODUCTS
                .filter((product) => snapshot.selectedProducts.includes(product))
                .flatMap((product) => getProductRegionIds(product, snapshot.productRegionIds)
                  .map((regionId) => (
                    <Command.Item data-product={product} key={`${product}-${regionId}`} value={`${productLabel(product)} ${getRegionShortName(regionId)} ${regionId}`} onSelect={() => run(() => runWorkspaceAction({ type: "open-entry", product, regionId }))}>
                      <ProductIcon product={product} />
                      <span>{productLabel(product)}</span>
                      <small>{getRegionShortName(regionId)}</small>
                    </Command.Item>
                  )))}
              {GLOBAL_PRODUCT_ENTRIES
                .filter((entry) => snapshot.selectedProducts.includes(entry.product))
                .map((entry) => (
                  <Command.Item data-product={entry.product} key={`${entry.product}-${entry.url ?? "entry"}`} value={`${productLabel(entry.product)} ${entry.label}`} onSelect={() => run(() => openGlobalProductEntry(entry))}>
                    <ConsoleEntryIcon product={entry.product} query={Boolean(entry.url)} />
                    <span>{productLabel(entry.product)}</span>
                    <small>{entry.label}</small>
                  </Command.Item>
                ))}
            </Command.Group>
          )}
        </Command.List>
      </div>
    </Command.Dialog>
  );
}
