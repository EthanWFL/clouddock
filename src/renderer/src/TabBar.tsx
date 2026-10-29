import { CheckCircle2, CircleAlert, History, LoaderCircle, ListFilter, Pin, CircleDot, Clock3, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { type Product, type WorkspaceTab } from "../../shared/model";
import { getTabDisplayTitle, productLabel } from "../../shared/workspace-display";
import { filterTabsForQueue, runWorkspaceAction, type TabTaskFilter } from "./actions";
import { ProductIcon } from "./ProductIcon";
import { useRendererStore } from "./store";

export const TabBar = memo(function TabBar() {
  const snapshot = useRendererStore(useShallow(({ snapshot }) => ({
    tabs: snapshot!.tabs,
    activeTabId: snapshot!.activeTabId,
    productFilter: snapshot!.productFilter,
    taskFilter: snapshot!.taskFilter,
    recentlyClosedTabs: snapshot!.recentlyClosedTabs,
  })));
  const tabIndices = useMemo(() => new Map(snapshot.tabs.map((tab, index) => [tab.id, index])), [snapshot.tabs]);
  const productFilter = snapshot.productFilter;
  const taskFilter = snapshot.taskFilter;
  const tabButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const previousTabsRef = useRef<{ activeTabId: string | null; tabIds: Set<string> } | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropTargetTabId, setDropTargetTabId] = useState<string | null>(null);
  const tabProducts = useMemo(
    () => [...new Set(snapshot.tabs.map((tab) => tab.product))],
    [snapshot.tabs],
  );
  const taskCounts = useMemo(() => {
    const counts = { todo: 0, doing: 0, done: 0, none: 0 };
    for (const tab of snapshot.tabs) counts[tab.taskStatus ?? "none"] += 1;
    return counts;
  }, [snapshot.tabs]);
  const visibleTabs = useMemo(
    () => filterTabsForQueue(
      snapshot.tabs,
      snapshot.activeTabId,
      productFilter,
      taskFilter,
    ),
    [productFilter, snapshot.activeTabId, snapshot.tabs, taskFilter],
  );

  useEffect(() => {
    if (productFilter !== "all" && !tabProducts.includes(productFilter)) {
      void runWorkspaceAction({
        type: "set-tab-filters",
        productFilter: "all",
        taskFilter,
      });
    }
  }, [productFilter, tabProducts, taskFilter]);

  const clearDragState = useCallback(() => {
    setDraggingTabId(null);
    setDropTargetTabId(null);
  }, []);

  const moveTab = useCallback((tabId: string, toIndex: number) => {
    void runWorkspaceAction({ type: "move-tab", tabId, toIndex });
  }, []);

  useEffect(() => {
    const previous = previousTabsRef.current;
    const addedTabs = previous
      ? snapshot.tabs.filter((tab) => !previous.tabIds.has(tab.id))
      : [];
    const activeChanged = !previous || previous.activeTabId !== snapshot.activeTabId;
    const targetTabId = addedTabs.length > 0
      ? addedTabs[addedTabs.length - 1].id
      : activeChanged
        ? snapshot.activeTabId
        : null;

    if (targetTabId) {
      tabButtonsRef.current.get(targetTabId)?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    }

    previousTabsRef.current = {
      activeTabId: snapshot.activeTabId,
      tabIds: new Set(snapshot.tabs.map((tab) => tab.id)),
    };
  }, [snapshot.activeTabId, snapshot.tabs]);

  return (
    <div className="tab-bar">
      <div className="tab-scroll" role="tablist" aria-label="打开的控制台标签">
        {visibleTabs.map((tab) => (
          <WorkspaceTabItem
            key={tab.id}
            tab={tab}
            index={tabIndices.get(tab.id)!}
            active={tab.id === snapshot.activeTabId}
            draggingTabId={draggingTabId}
            dropTargetTabId={dropTargetTabId}
            tabButtonsRef={tabButtonsRef}
            setDraggingTabId={setDraggingTabId}
            setDropTargetTabId={setDropTargetTabId}
            moveTab={moveTab}
            clearDragState={clearDragState}
          />
        ))}
      </div>
      <div className="tab-actions">
        {tabProducts.length > 1 && (
          <label className="tab-filter tab-product-filter" title="按产品筛选标签">
            <ListFilter size={14} />
            <select aria-label="按产品筛选标签" value={productFilter} onChange={(event) => void runWorkspaceAction({
              type: "set-tab-filters",
              productFilter: event.target.value as Product | "all",
              taskFilter,
            })}>
              <option value="all">全部</option>
              {tabProducts.map((product) => <option key={product} value={product}>{productLabel(product)}</option>)}
            </select>
          </label>
        )}
        <label className="tab-filter tab-task-filter" title="按任务状态筛选标签">
          <CircleDot size={14} />
          <select aria-label="按任务状态筛选标签" value={taskFilter} onChange={(event) => void runWorkspaceAction({
            type: "set-tab-filters",
            productFilter,
            taskFilter: event.target.value as TabTaskFilter,
          })}>
            <option value="all">全部状态</option>
            <option value="doing">处理中 ({taskCounts.doing})</option>
            <option value="todo">待处理 ({taskCounts.todo})</option>
            <option value="done">已完成 ({taskCounts.done})</option>
            <option value="none">未标记 ({taskCounts.none})</option>
          </select>
        </label>
        <button className="icon-button tab-action" title="重新打开最近关闭的标签" aria-label="重新打开最近关闭的标签" disabled={snapshot.recentlyClosedTabs.length === 0} onClick={() => void runWorkspaceAction({ type: "reopen-closed-tab" })}>
          <History size={16} />
        </button>
      </div>
    </div>
  );
});

const WorkspaceTabItem = memo(function WorkspaceTabItem({
  tab, index, active, draggingTabId, dropTargetTabId, tabButtonsRef,
  setDraggingTabId, setDropTargetTabId, moveTab, clearDragState,
}: {
  tab: WorkspaceTab;
  index: number;
  active: boolean;
  draggingTabId: string | null;
  dropTargetTabId: string | null;
  tabButtonsRef: React.RefObject<Map<string, HTMLButtonElement>>;
  setDraggingTabId: React.Dispatch<React.SetStateAction<string | null>>;
  setDropTargetTabId: React.Dispatch<React.SetStateAction<string | null>>;
  moveTab: (tabId: string, toIndex: number) => void;
  clearDragState: () => void;
}) {
  const taskStatusLabel = tab.taskStatus === "todo"
    ? "待处理"
    : tab.taskStatus === "doing"
      ? "处理中"
      : tab.taskStatus === "done"
        ? "已完成"
        : "未标记";
  const nextTaskStatus = tab.taskStatus === null
    ? "todo"
    : tab.taskStatus === "todo"
      ? "doing"
      : tab.taskStatus === "doing"
        ? "done"
        : null;
  return (
    <div
      className={[
        "tab",
        active ? "active" : "",
        tab.id === draggingTabId ? "dragging" : "",
        tab.id === dropTargetTabId ? "drop-target" : "",
      ].filter(Boolean).join(" ")}
      data-product={tab.product}
      data-state={active ? "active" : "inactive"}
      draggable
      onDragStart={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(".tab-control, .tab-close")) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-opsdock-tab", tab.id);
        setDraggingTabId(tab.id);
      }}
      onDragOver={(event) => {
        if (!draggingTabId || draggingTabId === tab.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropTargetTabId(tab.id);
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node)
          || !event.currentTarget.contains(event.relatedTarget)
        ) {
          setDropTargetTabId((current) => current === tab.id ? null : current);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (draggingTabId && draggingTabId !== tab.id) moveTab(draggingTabId, index);
        clearDragState();
      }}
      onDragEnd={clearDragState}
    >
      <button
        ref={(node) => {
          if (node) tabButtonsRef.current.set(tab.id, node);
          else tabButtonsRef.current.delete(tab.id);
        }}
        className={`tab-main ${active ? "active" : ""}`}
        id={`workspace-tab-${tab.id}`}
        role="tab"
        aria-selected={active}
        aria-controls="console-viewport"
        aria-keyshortcuts="ArrowLeft ArrowRight Home End Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
        tabIndex={active ? 0 : -1}
        onClick={() => void runWorkspaceAction({ type: "activate-tab", tabId: tab.id })}
        onKeyDown={(event) => {
          const snapshot = useRendererStore.getState().snapshot;
          if (!snapshot) return;
          const visibleTabs = filterTabsForQueue(snapshot.tabs, snapshot.activeTabId, snapshot.productFilter, snapshot.taskFilter);
          const visibleIndex = visibleTabs.findIndex((candidate) => candidate.id === tab.id);
          if (event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey) {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            const toIndex = index + (event.key === "ArrowLeft" ? -1 : 1);
            if (toIndex < 0 || toIndex >= snapshot.tabs.length) return;
            event.preventDefault();
            moveTab(tab.id, toIndex);
            return;
          }
          if (event.altKey || event.shiftKey || event.metaKey || event.ctrlKey) return;
          const targetIndex = event.key === "Home"
            ? 0
            : event.key === "End"
            ? visibleTabs.length - 1
            : event.key === "ArrowLeft"
                ? (visibleIndex - 1 + visibleTabs.length) % visibleTabs.length
                : event.key === "ArrowRight"
                  ? (visibleIndex + 1) % visibleTabs.length
                  : null;
          if (targetIndex === null || targetIndex === visibleIndex) return;
          event.preventDefault();
          const targetTab = visibleTabs[targetIndex];
          tabButtonsRef.current.get(targetTab.id)?.focus();
          void runWorkspaceAction({ type: "activate-tab", tabId: targetTab.id });
        }}
        title={getTabDisplayTitle(tab)}
      >
        <ProductIcon product={tab.product} size={15} />
        <span>{getTabDisplayTitle(tab)}</span>
        {tab.loadState === "loading" && <LoaderCircle className="spin tab-status" size={13} />}
        {(tab.loadState === "error" || tab.loadState === "crashed") && <CircleAlert className="tab-status error" size={13} />}
      </button>
      <button
        className={`tab-control tab-task-status ${tab.taskStatus ? "marked" : ""}`}
        data-task-status={tab.taskStatus ?? "none"}
        title={`任务状态：${taskStatusLabel}，点击切换`}
        aria-label={`${tab.title}任务状态：${taskStatusLabel}`}
        onClick={() => void runWorkspaceAction({
          type: "set-tab-task-status",
          tabId: tab.id,
          taskStatus: nextTaskStatus,
        })}
      >
        {tab.taskStatus === "todo" && <CircleDot size={12} />}
        {tab.taskStatus === "doing" && <Clock3 size={12} />}
        {tab.taskStatus === "done" && <CheckCircle2 size={12} />}
        {tab.taskStatus === null && <CircleDot size={12} />}
      </button>
      <button
        className={`tab-control tab-pin ${tab.pinned ? "selected" : ""}`}
        title={tab.pinned ? `取消固定 ${tab.title}` : `固定 ${tab.title}`}
        aria-label={tab.pinned ? `取消固定 ${tab.title}` : `固定 ${tab.title}`}
        aria-pressed={tab.pinned}
        onClick={() => void runWorkspaceAction({
          type: "set-tab-pinned",
          tabId: tab.id,
          pinned: !tab.pinned,
        })}
      ><Pin size={12} fill={tab.pinned ? "currentColor" : "none"} /></button>
      <button className="tab-close" title={`关闭 ${tab.title}`} aria-label={`关闭 ${tab.title}`} onClick={() => {
        void runWorkspaceAction({ type: "close-tab", tabId: tab.id });
      }}><X size={13} /></button>
    </div>
  );
});
