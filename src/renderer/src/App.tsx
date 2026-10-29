import { CircleAlert, LoaderCircle, Menu, RotateCcw, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { parseConsoleTarget, normalizeConsoleUrl } from "../../shared/console-url";
import { matchConsoleShortcut, type ConsoleShortcut } from "../../shared/console-shortcut";
import { filterTabsForQueue, removeFavoriteWithUndo, runViewAction, runWorkspaceAction } from "./actions";
import { useRendererStore } from "./store";
import { Onboarding, ProductSettingsModal } from "./ProductSettings";
import { FavoriteEditorModal, ModuleShortcutEditorModal, LoginCredentialsModal, LogoutModal } from "./WorkspaceDialogs";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { Toolbar } from "./Toolbar";
import { PageFindBar } from "./PageFindBar";

const LazyCommandPalette = lazy(() => import("./CommandPalette"));

function SnapshotNotice({ notice }: { notice: string }) {
  return (
    <div className="notice" role="status">
      <CircleAlert size={16} />
      <span>{notice}</span>
      <button
        aria-label="关闭提示"
        onClick={() => void runWorkspaceAction({ type: "set-notice", notice: null })}
      >
        <X size={14} />
      </button>
    </div>
  );
}

function EmptyWorkspace() {
  return (
    <div className="empty-workspace">
      <div className="empty-icon"><Menu size={22} /></div>
      <h2>选择一个控制台</h2>
      <p>从左侧选择模块，或按 <kbd>⌘K</kbd> 快速切换。</p>
    </div>
  );
}

export function App() {
  const snapshot = useRendererStore(useShallow(({ snapshot }) => snapshot ? ({
    onboardingComplete: snapshot.onboardingComplete,
    activeTabId: snapshot.activeTabId,
    productFilter: snapshot.productFilter,
    taskFilter: snapshot.taskFilter,
    notice: snapshot.onboardingComplete ? null : snapshot.notice,
  }) : null));
  const active = useRendererStore(({ snapshot }) => snapshot?.tabs.find((tab) => tab.id === snapshot.activeTabId));
  const setSnapshot = useRendererStore((state) => state.setSnapshot);
  const initializeSnapshot = useRendererStore((state) => state.initializeSnapshot);
  const commandMode = useRendererStore((state) => state.commandMode);
  const productSettingsOpen = useRendererStore((state) => state.productSettingsOpen);
  const loginCredentialsOpen = useRendererStore((state) => state.loginCredentialsOpen);
  const favoriteEditorOpen = useRendererStore((state) => state.favoriteEditorOpen);
  const moduleShortcutEditorOpen = useRendererStore((state) => state.moduleShortcutEditorOpen);
  const logoutConfirmOpen = useRendererStore((state) => state.logoutConfirmOpen);
  const removedFavorite = useRendererStore((state) => state.removedFavorite);
  const removedModuleShortcut = useRendererStore((state) => state.removedModuleShortcut);
  const openCommand = useRendererStore((state) => state.openCommand);
  const setFavoriteEditor = useRendererStore((state) => state.setFavoriteEditor);
  const setRemovedFavorite = useRendererStore((state) => state.setRemovedFavorite);
  const setRemovedModuleShortcut = useRendererStore((state) => state.setRemovedModuleShortcut);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [pageFindOpen, setPageFindOpen] = useState(false);
  const [pageFindText, setPageFindText] = useState("");
  const [pageFinding, setPageFinding] = useState(false);
  const [pageFindResult, setPageFindResult] = useState({ activeMatchOrdinal: 0, matches: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const pageFindInputRef = useRef<HTMLInputElement>(null);
  const pageFindTimerRef = useRef<number | null>(null);
  const pageFindRequestRef = useRef(0);
  const pageFindTextRef = useRef("");
  const previousActiveTabIdRef = useRef<string | null>(snapshot?.activeTabId ?? null);

  const blockingModalOpen = productSettingsOpen || loginCredentialsOpen || favoriteEditorOpen || moduleShortcutEditorOpen || logoutConfirmOpen;

  const runPageFind = useCallback((text: string, forward: boolean, findNext: boolean) => {
    pageFindTextRef.current = text;
    const request = ++pageFindRequestRef.current;
    const tabId = useRendererStore.getState().snapshot?.activeTabId;
    if (pageFindTimerRef.current !== null) window.clearTimeout(pageFindTimerRef.current);
    if (!findNext) setPageFindResult({ activeMatchOrdinal: 0, matches: 0 });
    setPageFinding(Boolean(text));
    if (!text) {
      pageFindTimerRef.current = null;
      setPageFindResult({ activeMatchOrdinal: 0, matches: 0 });
      void runViewAction({ type: "stop-find" });
      return;
    }
    pageFindTimerRef.current = window.setTimeout(() => {
      pageFindTimerRef.current = null;
      void window.opsdock.performViewAction({ type: "find", text, forward, findNext })
        .then((result) => {
          if (request !== pageFindRequestRef.current) return;
          setPageFinding(false);
          if (result && result.tabId === tabId && result.text === text) setPageFindResult(result);
        })
        .catch(() => {
          if (request === pageFindRequestRef.current) {
            setPageFinding(false);
            useRendererStore.getState().setActionError("页内查找失败，请重试");
          }
        });
    }, findNext ? 0 : 180);
  }, []);

  const closePageFind = useCallback(() => {
    pageFindRequestRef.current += 1;
    if (pageFindTimerRef.current !== null) window.clearTimeout(pageFindTimerRef.current);
    pageFindTimerRef.current = null;
    setPageFindOpen(false);
    setPageFinding(false);
    setPageFindResult({ activeMatchOrdinal: 0, matches: 0 });
    void runViewAction({ type: "stop-find", restoreFocus: true });
  }, []);

  const openPageFind = useCallback(() => {
    setPageFindOpen(true);
    const text = pageFindTextRef.current;
    if (text) runPageFind(text, true, false);
    window.requestAnimationFrame(() => pageFindInputRef.current?.select());
  }, [runPageFind]);

  useEffect(() => () => {
    pageFindRequestRef.current += 1;
    if (pageFindTimerRef.current !== null) window.clearTimeout(pageFindTimerRef.current);
    void runViewAction({ type: "stop-find" });
  }, []);

  useEffect(() => {
    if (!pageFindOpen) return;
    const frame = window.requestAnimationFrame(() => pageFindInputRef.current?.select());
    return () => window.cancelAnimationFrame(frame);
  }, [pageFindOpen]);

  useEffect(() => {
    const activeTabId = snapshot?.activeTabId ?? null;
    const previousActiveTabId = previousActiveTabIdRef.current;
    previousActiveTabIdRef.current = activeTabId;
    if (pageFindOpen && previousActiveTabId !== activeTabId) {
      setPageFindText("");
      pageFindTextRef.current = "";
      closePageFind();
    }
  }, [closePageFind, pageFindOpen, snapshot?.activeTabId]);

  useEffect(() => {
    if (!removedFavorite) return;
    const timer = window.setTimeout(() => setRemovedFavorite(null), 7_000);
    return () => window.clearTimeout(timer);
  }, [removedFavorite, setRemovedFavorite]);

  useEffect(() => {
    if (!removedModuleShortcut) return;
    const timer = window.setTimeout(() => setRemovedModuleShortcut(null), 7_000);
    return () => window.clearTimeout(timer);
  }, [removedModuleShortcut, setRemovedModuleShortcut]);

  useEffect(() => {
    return window.opsdock.subscribeWorkspace((nextSnapshot) => {
      setStartupError(null);
      setSnapshot(nextSnapshot);
    });
  }, [setSnapshot]);

  useEffect(() => {
    let mounted = true;
    setStartupError(null);
    void window.opsdock.getWorkspace()
      .then((initial) => {
        if (mounted) initializeSnapshot(initial);
      })
      .catch(() => {
        if (mounted) setStartupError("工作区恢复失败，请重试");
      });
    return () => {
      mounted = false;
    };
  }, [initializeSnapshot, startupAttempt]);

  useEffect(() => {
    const runShortcut = (shortcut: ConsoleShortcut) => {
      if (shortcut.type === "open-command-palette") {
        if (!blockingModalOpen) openCommand("switcher");
        return;
      }
      if (shortcut.type === "open-link-opener") {
        if (!blockingModalOpen) openCommand("link-opener");
        return;
      }
      if (shortcut.type === "close-active-tab") {
        if (!blockingModalOpen && !commandMode && snapshot?.activeTabId) {
          void runWorkspaceAction({ type: "close-tab", tabId: snapshot.activeTabId });
        }
        return;
      }
      if (shortcut.type === "reopen-closed-tab") {
        if (!blockingModalOpen && !commandMode) void runWorkspaceAction({ type: "reopen-closed-tab" });
        return;
      }
      if (shortcut.type === "reload-active-tab") {
        if (!blockingModalOpen && !commandMode && snapshot?.activeTabId) {
          void runViewAction({ type: "reload" });
        }
        return;
      }
      if (shortcut.type === "open-page-find") {
        if (!blockingModalOpen && !commandMode && snapshot?.activeTabId) {
          openPageFind();
        }
        return;
      }
      if (shortcut.type === "navigate-back" || shortcut.type === "navigate-forward") {
        if (blockingModalOpen || commandMode) return;
        const current = useRendererStore.getState().snapshot;
        const currentActive = current?.tabs.find((tab) => tab.id === current.activeTabId);
        const canNavigate = shortcut.type === "navigate-back"
          ? currentActive?.canGoBack
          : currentActive?.canGoForward;
        if (canNavigate) {
          void runViewAction({ type: shortcut.type === "navigate-back" ? "back" : "forward" });
        }
        return;
      }
      if (shortcut.type === "toggle-active-favorite") {
        if (blockingModalOpen || commandMode) return;
        const current = useRendererStore.getState().snapshot;
        const currentActive = current?.tabs.find((tab) => tab.id === current.activeTabId);
        if (!current || !currentActive || currentActive.isAuthenticating) return;
        const existing = current.favorites.find((favorite) =>
          normalizeConsoleUrl(favorite.url) === normalizeConsoleUrl(currentActive.url));
        if (existing) void removeFavoriteWithUndo(existing);
        else if (parseConsoleTarget(currentActive.url)) setFavoriteEditor(true);
        return;
      }

      if (blockingModalOpen || commandMode) return;
      const current = useRendererStore.getState().snapshot;
      if (!current || current.tabs.length === 0) return;

      const queueTabs = filterTabsForQueue(
        current.tabs,
        current.activeTabId,
        current.productFilter,
        current.taskFilter,
      );
      const activeIndex = queueTabs.findIndex((tab) => tab.id === current.activeTabId);
      let targetIndex: number;
      if (shortcut.type === "activate-tab") {
        targetIndex = shortcut.position === 9
          ? queueTabs.length - 1
          : shortcut.position - 1;
      } else if (shortcut.type === "activate-next-tab") {
        targetIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % queueTabs.length;
      } else {
        targetIndex = activeIndex < 0
          ? queueTabs.length - 1
          : (activeIndex - 1 + queueTabs.length) % queueTabs.length;
      }

      const target = queueTabs[targetIndex];
      if (target && target.id !== current.activeTabId) {
        void runWorkspaceAction({ type: "activate-tab", tabId: target.id });
      }
    };

    const listener = (event: KeyboardEvent) => {
      const shortcut = matchConsoleShortcut({
        type: "keyDown",
        key: event.key,
        meta: event.metaKey,
        control: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
      });
      if (!shortcut) return;
      event.preventDefault();
      runShortcut(shortcut);
    };

    window.addEventListener("keydown", listener);
    const unsubscribeShortcut = window.opsdock.subscribeConsoleShortcut(runShortcut);
    return () => {
      window.removeEventListener("keydown", listener);
      unsubscribeShortcut();
    };
  }, [blockingModalOpen, commandMode, openCommand, openPageFind, pageFindText, runPageFind, setFavoriteEditor, snapshot?.activeTabId, snapshot?.productFilter, snapshot?.taskFilter]);
  const workspaceReady = Boolean(snapshot?.onboardingComplete);
  const anyOverlay = Boolean(commandMode) || blockingModalOpen;
  const showRemoteView = Boolean(active && !anyOverlay && active.loadState !== "error" && active.loadState !== "crashed");

  const lastReportedBoundsRef = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
    visible: boolean;
  } | null>(null);
  const boundsFrameRef = useRef<number | null>(null);

  const reportBounds = useCallback(() => {
    if (boundsFrameRef.current !== null) return;
    boundsFrameRef.current = window.requestAnimationFrame(() => {
      boundsFrameRef.current = null;
      if (!workspaceReady) return;
      const node = viewportRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const next = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: showRemoteView,
      };
      const previous = lastReportedBoundsRef.current;
      if (
        previous
        && previous.x === next.x
        && previous.y === next.y
        && previous.width === next.width
        && previous.height === next.height
        && previous.visible === next.visible
      ) return;
      lastReportedBoundsRef.current = next;
      window.opsdock.setViewBounds(next);
    });
  }, [showRemoteView, workspaceReady]);

  useEffect(() => {
    reportBounds();
    const observer = new ResizeObserver(reportBounds);
    if (viewportRef.current) observer.observe(viewportRef.current);
    window.addEventListener("resize", reportBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reportBounds);
      if (boundsFrameRef.current !== null) {
        window.cancelAnimationFrame(boundsFrameRef.current);
        boundsFrameRef.current = null;
      }
      const hidden = { x: 0, y: 0, width: 0, height: 0, visible: false };
      const previous = lastReportedBoundsRef.current;
      if (
        !previous
        || previous.x !== hidden.x
        || previous.y !== hidden.y
        || previous.width !== hidden.width
        || previous.height !== hidden.height
        || previous.visible !== hidden.visible
      ) {
        lastReportedBoundsRef.current = hidden;
        window.opsdock.setViewBounds(hidden);
      }
    };
  }, [reportBounds]);

  if (!snapshot) {
    if (startupError) {
      return (
        <div className="loading-screen">
          <CircleAlert size={24} />
          <span role="alert">{startupError}</span>
          <button className="primary-button small" onClick={() => setStartupAttempt((attempt) => attempt + 1)}>
            <RotateCcw size={15} />重试
          </button>
        </div>
      );
    }
    return <div className="loading-screen"><LoaderCircle className="spin" size={24} /><span>正在恢复工作区</span></div>;
  }
  if (!snapshot.onboardingComplete) {
    return (
      <>
        <Onboarding />
        {snapshot.notice && <SnapshotNotice notice={snapshot.notice} />}
      </>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <main className={`workspace ${pageFindOpen ? "find-open" : ""}`.trim()}>
        <header className={`workspace-chrome ${pageFindOpen ? "find-open" : ""}`.trim()}>
          <TabBar />
          <Toolbar active={active} onOpenFind={openPageFind} />
          {pageFindOpen && (
            <PageFindBar
              inputRef={pageFindInputRef}
              value={pageFindText}
              activeMatchOrdinal={pageFindResult.activeMatchOrdinal}
              matches={pageFindResult.matches}
              searching={pageFinding}
              onChange={(text) => {
                setPageFindText(text);
                runPageFind(text, true, false);
              }}
              onFind={(forward) => runPageFind(pageFindText, forward, true)}
              onClose={closePageFind}
            />
          )}
        </header>
        <div
          className="console-viewport"
          id="console-viewport"
          role="tabpanel"
          aria-labelledby={active ? `workspace-tab-${active.id}` : undefined}
          aria-label={active ? undefined : "空工作区"}
          ref={viewportRef}
        >
          {!active && <EmptyWorkspace />}
          {active?.loadState === "error" && (
            <div className="console-error">
              <CircleAlert size={26} />
              <h2>页面加载失败</h2>
              <p>{active.errorMessage ?? "无法打开阿里云控制台"}</p>
              <button className="primary-button small" onClick={() => void runViewAction({ type: "reload" })}><RotateCcw size={16} />重新加载</button>
            </div>
          )}
          {active?.loadState === "crashed" && (
            <div className="console-error">
              <CircleAlert size={26} />
              <h2>控制台页面已停止</h2>
              <p>{active.errorMessage}</p>
              <button className="primary-button small" onClick={() => void runViewAction({ type: "reload" })}><RotateCcw size={16} />重新加载</button>
            </div>
          )}
        </div>
      </main>

      {commandMode && (
        <Suspense fallback={null}>
          <LazyCommandPalette />
        </Suspense>
      )}
      {productSettingsOpen && <ProductSettingsModal />}
      {loginCredentialsOpen && <LoginCredentialsModal />}
      {favoriteEditorOpen && <FavoriteEditorModal />}
      {moduleShortcutEditorOpen && <ModuleShortcutEditorModal />}
      {logoutConfirmOpen && <LogoutModal />}
    </div>
  );
}
