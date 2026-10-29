import {
  app,
  clipboard,
  Menu,
  type BrowserWindow,
  type HandlerDetails,
  type LoadURLOptions,
  type MenuItemConstructorOptions,
  type Rectangle,
  WebContentsView,
} from "electron";
import { matchConsoleShortcut, type ConsoleShortcut } from "../../../shared/console-shortcut";
import { parseObservedConsoleTarget } from "../../../shared/console-url";
import type { WorkspaceTab } from "../../../shared/model";
import { decideNavigation, isAllowedAuthHost } from "../../../shared/navigation-policy";
import { REMOTE_CREDENTIALS_FILL_CHANNEL } from "../../../shared/remote-ipc";
import type { PageFindResult, ViewAction } from "../../../shared/ipc";
import type { Workspace } from "../workspace/workspace";
import type { ConsoleSession } from "../console-session/console-session";
import type { CredentialStore } from "../console-session/credential-store";
import { formatConsoleLoadError, formatConsoleLoadFailure } from "./load-error-message";

const GIBIBYTE = 1024 ** 3;
const MEDIUM_WORKING_SET = GIBIBYTE;
const PRESSURE_WORKING_SET = 1.5 * GIBIBYTE;
const RECYCLE_INTERVAL_MS = 45_000;
const MAX_UNRESPONSIVE_RECOVERIES = 2;
const UNRESPONSIVE_STABLE_RESET_MS = 30_000;
const RETRY_LOAD_TIMEOUT_MS = 30_000;

export interface ExternalOpener {
  open(url: string): Promise<void>;
}

export interface ConsoleViewsOptions {
  window: BrowserWindow;
  workspace: Workspace;
  session: ConsoleSession;
  credentialStore?: CredentialStore;
  autofillPreload: string;
  externalOpener: ExternalOpener;
  onShortcut: (shortcut: ConsoleShortcut) => void;
  allowTestServer?: boolean;
  enableDevTools?: boolean;
}

interface ManagedView {
  view: WebContentsView;
  tabId: string;
  lastVisibleAt: number;
}

export interface ConsoleViewDiagnostics {
  tabId: string;
  created: boolean;
  destroyed: boolean;
  visible: boolean;
  url: string;
  bounds: Rectangle;
  sessionPartition: string;
}

export interface ConsoleRetryResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

export class ConsoleViews {
  private readonly views = new Map<string, ManagedView>();
  private readonly popupLoads = new Map<string, LoadURLOptions>();
  private activeTabId: string | null = null;
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private contentVisible = false;
  private recycleQueue: Promise<void> = Promise.resolve();
  private recycleScheduled = false;
  private recycleRequested = false;
  private recycleTimer: ReturnType<typeof setInterval> | null;
  private retryPromise: Promise<ConsoleRetryResult> | null = null;
  private retryController: AbortController | null = null;
  private retryingTabId: string | null = null;
  private destroying = false;
  private cancelFind: (() => void) | null = null;
  private findContents: Electron.WebContents | null = null;
  private readonly recyclingTabIds = new Set<string>();
  private readonly recycledTabIds = new Set<string>();
  private recycledViewCount = 0;
  private reloadedAfterRecycleCount = 0;
  private peakLiveViewCount = 0;

  constructor(private readonly options: ConsoleViewsOptions) {
    this.recycleTimer = null;
    this.startRecycleTimer();
  }

  async activate(tab: WorkspaceTab): Promise<void> {
    if (this.destroying) return;
    if (tab.id !== this.activeTabId) this.stopFind();
    this.startRecycleTimer();
    this.activeTabId = tab.id;
    if (this.recyclingTabIds.has(tab.id)) {
      await this.recycleQueue.catch(() => undefined);
    }
    if (this.destroying || this.activeTabId !== tab.id) return;
    for (const [tabId, managed] of this.views) {
      managed.view.setVisible(tabId === tab.id && this.contentVisible);
    }

    const navigation = decideNavigation(tab.url, "current", {
      allowTestServer: this.options.allowTestServer,
    });
    if (navigation.kind !== "allow-current") {
      void this.options.workspace.dispatch({
        type: "update-tab",
        tabId: tab.id,
        loadState: "error",
        errorMessage:
          navigation.kind === "block"
            ? navigation.reason
            : "此链接不能在 CloudDock 控制台视图中打开",
      });
      return;
    }

    let managed = this.views.get(tab.id);
    if (!managed || managed.view.webContents.isDestroyed()) {
      managed = this.create(tab);
      this.views.set(tab.id, managed);
      this.peakLiveViewCount = Math.max(this.peakLiveViewCount, this.views.size);
      if (this.recycledTabIds.delete(tab.id)) this.reloadedAfterRecycleCount += 1;
      void this.options.workspace.dispatch({
        type: "update-tab",
        tabId: tab.id,
        loadState: "loading",
      });
      const loadingView = managed;
      const loadingContents = loadingView.view.webContents;
      const loadOptions = this.popupLoads.get(tab.id);
      this.popupLoads.delete(tab.id);
      const loading = loadOptions ? loadingContents.loadURL(tab.url, loadOptions) : loadingContents.loadURL(tab.url);
      void loading.catch(async (error: unknown) => {
        if (
          loadingContents.isDestroyed() ||
          this.views.get(tab.id) !== loadingView
        ) {
          return;
        }
        const errorMessage = formatConsoleLoadFailure(error);
        if (!errorMessage) return;
        await this.options.workspace.dispatch({
          type: "update-tab",
          tabId: tab.id,
          loadState: "error",
          errorMessage,
        });
      });
    }

    managed.lastVisibleAt = Date.now();
    managed.view.setBounds(this.bounds);
    managed.view.setVisible(this.contentVisible);
    this.options.window.contentView.addChildView(managed.view);
    this.queueRecycle();
  }

  setBounds(bounds: Rectangle, visible: boolean): void {
    const nextBounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    };
    if (
      visible === this.contentVisible
      && nextBounds.x === this.bounds.x
      && nextBounds.y === this.bounds.y
      && nextBounds.width === this.bounds.width
      && nextBounds.height === this.bounds.height
    ) return;
    this.bounds = nextBounds;
    this.contentVisible = visible;
    const managed = this.activeTabId ? this.views.get(this.activeTabId) : undefined;
    if (!managed || managed.view.webContents.isDestroyed()) return;
    if (visible) managed.view.setBounds(this.bounds);
    managed.view.setVisible(visible);
  }

  async close(tabId: string, force = false): Promise<boolean> {
    this.popupLoads.delete(tabId);
    const managed = this.views.get(tabId);
    if (!managed) {
      this.recycledTabIds.delete(tabId);
      return true;
    }
    const webContents = managed.view.webContents;
    if (webContents.isDestroyed()) {
      this.detach(tabId, managed);
      return true;
    }

    const outcome = await new Promise<"destroyed" | "prevented" | "timeout">((resolve) => {
      let settled = false;
      const finish = (result: "destroyed" | "prevented" | "timeout") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        webContents.removeListener("destroyed", onDestroyed);
        webContents.removeListener("will-prevent-unload", onPrevent);
        resolve(result);
      };
      const onDestroyed = () => finish("destroyed");
      const onPrevent = () => finish("prevented");
      const timer = setTimeout(() => finish("timeout"), 2_000);
      webContents.once("destroyed", onDestroyed);
      if (!force) webContents.once("will-prevent-unload", onPrevent);
      webContents.close({ waitForBeforeUnload: !force });
      if (webContents.isDestroyed()) finish("destroyed");
    });

    if (outcome !== "destroyed") {
      if (outcome === "timeout") {
        webContents.once("destroyed", () => this.detach(tabId, managed));
      }
      return false;
    }
    this.detach(tabId, managed);
    return true;
  }

  async destroyAll(force = true): Promise<void> {
    this.destroying = true;
    this.stopFind();
    this.retryController?.abort();
    this.activeTabId = null;
    if (this.recycleTimer) {
      clearInterval(this.recycleTimer);
      this.recycleTimer = null;
    }
    try {
      await this.retryPromise?.catch(() => undefined);
      await this.recycleQueue.catch(() => undefined);
      const failed: string[] = [];
      for (const tabId of [...this.views.keys()]) {
        if (!(await this.close(tabId, force))) {
          if (!force) throw new Error("页面阻止退出，请先保存或取消未完成的编辑");
          failed.push(tabId);
        }
      }
      if (failed.length > 0) throw new Error("部分控制台页面未能关闭");
      this.recycledTabIds.clear();
      this.popupLoads.clear();
    } finally {
      this.destroying = false;
    }
  }

  async restoreActiveView(): Promise<void> {
    this.startRecycleTimer();
    for (const tab of this.options.workspace.getSnapshot().tabs) {
      const managed = this.views.get(tab.id);
      if (!managed || managed.view.webContents.isDestroyed()) {
        await this.options.workspace.dispatch({ type: "update-tab", tabId: tab.id, loadState: "deferred", canGoBack: false, canGoForward: false });
      }
    }
    const snapshot = this.options.workspace.getSnapshot();
    const active = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);
    if (active) await this.activate(active);
  }

  retryFailedTabs(): Promise<ConsoleRetryResult> {
    if (this.retryPromise) return this.retryPromise;
    if (this.destroying) return Promise.resolve({ attempted: 0, succeeded: 0, failed: 0 });
    const controller = new AbortController();
    this.retryController = controller;
    const retry = this.recycleQueue
      .catch(() => undefined)
      .then(() => this.runRetryFailedTabs(controller.signal));
    this.retryPromise = retry.finally(() => {
      this.retryPromise = null;
      this.retryController = null;
      this.queueRecycle();
    });
    return this.retryPromise;
  }

  async perform(action: ViewAction): Promise<PageFindResult | null> {
    if (action.type === "stop-find") {
      this.stopFind();
      const contents = this.activeTabId ? this.views.get(this.activeTabId)?.view.webContents : undefined;
      if (action.restoreFocus && contents && !contents.isDestroyed()) {
        this.options.window.focus();
        contents.focus();
      }
      return null;
    }
    let managed = this.activeTabId ? this.views.get(this.activeTabId) : undefined;
    if (action.type === "reload" && (!managed || managed.view.webContents.isDestroyed())) {
      const activeTab = this.options.workspace
        .getSnapshot()
        .tabs.find((tab) => tab.id === this.activeTabId);
      if (!activeTab) return null;
      if (managed) this.detach(activeTab.id, managed);
      await this.activate(activeTab);
      return null;
    }
    if (!managed || managed.view.webContents.isDestroyed()) return null;
    const { webContents } = managed.view;
    switch (action.type) {
      case "back":
        if (webContents.navigationHistory.canGoBack()) webContents.navigationHistory.goBack();
        break;
      case "forward":
        if (webContents.navigationHistory.canGoForward()) webContents.navigationHistory.goForward();
        break;
      case "reload":
        webContents.reload();
        break;
      case "open-system": {
        const url = this.getShareableUrl(webContents.getURL());
        if (!url) return null;
        try {
          if (new URL(url).protocol === "https:") await this.options.externalOpener.open(url);
        } catch {
          // A malformed observed URL is not safe to pass to the operating system.
        }
        break;
      }
      case "copy-link": {
        const url = this.getShareableUrl(webContents.getURL());
        if (url) clipboard.writeText(url);
        break;
      }
      case "find": {
        this.cancelFind?.();
        this.findContents = webContents;
        return new Promise<PageFindResult | null>((resolve, reject) => {
          let requestId = 0;
          const finish = (result: PageFindResult | null, error?: Error) => {
            clearTimeout(timer);
            webContents.removeListener("found-in-page", onResult);
            webContents.removeListener("destroyed", cancel);
            webContents.removeListener("did-start-navigation", cancel);
            this.cancelFind = null;
            if (error) reject(error);
            else resolve(result);
          };
          const cancel = () => finish(null);
          const onResult = (_event: Electron.Event, result: Electron.Result) => {
            if (result.requestId !== requestId || !result.finalUpdate) return;
            finish({ tabId: managed.tabId, text: action.text, activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches });
          };
          const timer = setTimeout(() => finish(null, new Error("页内查找超时，请重试")), 5_000);
          this.cancelFind = cancel;
          webContents.on("found-in-page", onResult);
          webContents.once("destroyed", cancel);
          webContents.once("did-start-navigation", cancel);
          try {
            requestId = webContents.findInPage(action.text, {
              forward: action.forward,
              // Electron uses true to start a new search, unlike our next-match command.
              findNext: !action.findNext,
            });
          } catch (error) {
            finish(null, error instanceof Error ? error : new Error("页内查找失败"));
          }
        });
      }
    }
    return null;
  }

  private stopFind(): void {
    this.cancelFind?.();
    if (this.findContents && !this.findContents.isDestroyed()) {
      this.findContents.stopFindInPage("clearSelection");
    }
    this.findContents = null;
  }

  async fillActiveLoginCredentials(): Promise<void> {
    const managed = this.activeTabId ? this.views.get(this.activeTabId) : undefined;
    if (!managed || managed.view.webContents.isDestroyed()) return;
    await this.fillLoginCredentials(managed.view.webContents);
  }

  diagnostics(tabs: WorkspaceTab[]): ConsoleViewDiagnostics[] {
    return tabs.map((tab) => {
      const managed = this.views.get(tab.id);
      return {
        tabId: tab.id,
        created: Boolean(managed),
        destroyed: managed ? managed.view.webContents.isDestroyed() : false,
        visible: Boolean(managed && tab.id === this.activeTabId && this.contentVisible),
        url: managed && !managed.view.webContents.isDestroyed() ? managed.view.webContents.getURL() : tab.url,
        bounds: managed?.view.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 },
        sessionPartition: this.options.session.partition,
      };
    });
  }

  performanceDiagnostics() {
    return {
      recycledViewCount: this.recycledViewCount,
      reloadedAfterRecycleCount: this.reloadedAfterRecycleCount,
      peakLiveViewCount: this.peakLiveViewCount,
    };
  }

  private create(tab: WorkspaceTab): ManagedView {
    const view = new WebContentsView({
      webPreferences: {
        session: this.options.session.electronSession,
        preload: this.options.autofillPreload,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        devTools: Boolean(this.options.enableDevTools && !app.isPackaged),
      },
    });
    view.setBackgroundColor("#ffffff");
    view.setBounds(this.bounds);
    view.setVisible(false);
    this.options.window.contentView.addChildView(view);
    this.attachEvents(tab.id, view);
    return { view, tabId: tab.id, lastVisibleAt: Date.now() };
  }

  private attachEvents(tabId: string, view: WebContentsView): void {
    const { webContents } = view;
    let mainFrameLoadFailed = false;
    let recoveringFromUnresponsive = false;
    let unresponsiveRecoveries = 0;
    let unresponsiveLimitReported = false;
    let unresponsiveStableTimer: ReturnType<typeof setTimeout> | null = null;
    const clearUnresponsiveStableTimer = () => {
      if (unresponsiveStableTimer) clearTimeout(unresponsiveStableTimer);
      unresponsiveStableTimer = null;
    };
    const updateNavigationState = () => {
      if (webContents.isDestroyed()) return;
      const url = webContents.getURL();
      const target = parseObservedConsoleTarget(url, this.options.allowTestServer);
      void this.options.workspace.dispatch({
        type: "update-tab",
        tabId,
        url: url || undefined,
        target: target ? { product: target.product, regionId: target.regionId } : undefined,
        canGoBack: webContents.navigationHistory.canGoBack(),
        canGoForward: webContents.navigationHistory.canGoForward(),
      });
    };

    webContents.on("did-start-loading", () => {
      clearUnresponsiveStableTimer();
      mainFrameLoadFailed = false;
      void this.options.workspace.dispatch({ type: "update-tab", tabId, loadState: "loading" });
    });
    webContents.on("did-stop-loading", () => {
      recoveringFromUnresponsive = false;
      if (!mainFrameLoadFailed) {
        void this.options.workspace.dispatch({ type: "update-tab", tabId, loadState: "ready" });
        unresponsiveStableTimer = setTimeout(() => {
          unresponsiveRecoveries = 0;
          unresponsiveLimitReported = false;
          unresponsiveStableTimer = null;
        }, UNRESPONSIVE_STABLE_RESET_MS);
      }
      updateNavigationState();
    });
    webContents.on("did-finish-load", () => void this.fillLoginCredentials(webContents));
    webContents.on("did-navigate", updateNavigationState);
    webContents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) updateNavigationState();
    });
    webContents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      if (
        title.trim()
        && parseObservedConsoleTarget(webContents.getURL(), this.options.allowTestServer)
      ) {
        void this.options.workspace.dispatch({ type: "update-tab", tabId, title: title.trim() });
      }
    });
    webContents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      mainFrameLoadFailed = true;
      void this.options.workspace.dispatch({
        type: "update-tab",
        tabId,
        loadState: "error",
        errorMessage: formatConsoleLoadError(errorCode, errorDescription),
      });
    });
    webContents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit") return;
      mainFrameLoadFailed = true;
      void this.options.workspace.dispatch({
        type: "update-tab",
        tabId,
        loadState: "crashed",
        errorMessage: "控制台页面已崩溃，可以刷新或关闭标签",
      });
    });
    webContents.on("unresponsive", () => {
      if (webContents.isDestroyed() || recoveringFromUnresponsive) return;
      clearUnresponsiveStableTimer();
      if (unresponsiveRecoveries >= MAX_UNRESPONSIVE_RECOVERIES) {
        if (!unresponsiveLimitReported) {
          unresponsiveLimitReported = true;
          void this.options.workspace.dispatch({
            type: "update-tab",
            tabId,
            loadState: "error",
            errorMessage: "控制台页面持续无响应，请手动刷新或关闭标签",
          });
        }
        return;
      }
      unresponsiveRecoveries += 1;
      recoveringFromUnresponsive = true;
      void this.options.workspace.dispatch({
        type: "update-tab",
        tabId,
        loadState: "loading",
      });
      webContents.reload();
    });
    webContents.on("responsive", () => {
      recoveringFromUnresponsive = false;
    });
    webContents.once("destroyed", clearUnresponsiveStableTimer);
    webContents.on("context-menu", (event, params) => {
      event.preventDefault();
      const template: MenuItemConstructorOptions[] = [];
      const linkDecision = params.linkURL
        ? decideNavigation(params.linkURL, "popup", {
            allowTestServer: this.options.allowTestServer,
          })
        : null;
      if (linkDecision?.kind === "open-console-tab") {
        template.push({
          label: "在新标签页打开",
          click: () => {
            void this.options.workspace.dispatch({
              type: "open-url",
              ...linkDecision.target,
              sourceTabId: tabId,
            });
          },
        });
        template.push({
          label: "复制链接地址",
          click: () => clipboard.writeText(params.linkURL),
        });
      }
      const editItems: MenuItemConstructorOptions[] = [];
      if (params.editFlags.canCopy) {
        editItems.push({ label: "复制", click: () => webContents.copy() });
      }
      if (params.editFlags.canPaste) {
        editItems.push({ label: "粘贴", click: () => webContents.paste() });
      }
      if (params.editFlags.canSelectAll) {
        editItems.push({ label: "全选", click: () => webContents.selectAll() });
      }
      if (template.length > 0 && editItems.length > 0) template.push({ type: "separator" });
      template.push(...editItems);
      if (template.length > 0) {
        Menu.buildFromTemplate(template).popup({ window: this.options.window });
      }
    });
    webContents.on("before-input-event", (event, input) => {
      const shortcut = matchConsoleShortcut(input);
      if (shortcut) {
        event.preventDefault();
        this.options.onShortcut(shortcut);
        return;
      }
      if (app.isPackaged && input.meta && input.alt && input.key.toLowerCase() === "i") {
        event.preventDefault();
      }
    });
    webContents.on("will-navigate", (event, url) => this.handleCurrentNavigation(webContents, event, url));
    webContents.on("will-redirect", (event, url) => this.handleCurrentNavigation(webContents, event, url));
    webContents.setWindowOpenHandler((details) => {
      this.handlePopupNavigation(webContents, details.url, details, tabId);
      return { action: "deny" };
    });
  }

  private async fillLoginCredentials(webContents: Electron.WebContents): Promise<void> {
    const url = webContents.getURL();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !isAllowedAuthHost(parsed.hostname)) return;
      const credentials = await this.options.credentialStore?.get();
      if (!credentials || webContents.isDestroyed() || webContents.getURL() !== url) return;
      webContents.send(REMOTE_CREDENTIALS_FILL_CHANNEL, credentials);
    } catch {
      // Autofill is optional and must never disrupt the remote login page.
    }
  }

  private loadPopupInCurrentView(
    webContents: Electron.WebContents,
    url: string,
    details?: Pick<HandlerDetails, "postBody" | "referrer">,
  ): void {
    const options: LoadURLOptions = {};
    if (details?.referrer.url) options.httpReferrer = details.referrer;
    if (details?.postBody) {
      const { boundary, contentType, data } = details.postBody;
      options.postData = data;
      options.extraHeaders = `Content-Type: ${contentType}${boundary ? `; boundary=${boundary}` : ""}`;
    }
    const loading = Object.keys(options).length > 0
      ? webContents.loadURL(url, options)
      : webContents.loadURL(url);
    this.handleNavigationLoad(loading);
  }

  private handlePopupNavigation(
    webContents: Electron.WebContents,
    url: string,
    details?: Pick<HandlerDetails, "postBody" | "referrer">,
    sourceTabId?: string,
  ): void {
    const decision = decideNavigation(url, "popup", {
      allowTestServer: this.options.allowTestServer,
    });
    if (decision.kind === "open-console-tab") {
      if (details?.postBody) {
        const { boundary, contentType, data } = details.postBody;
        void this.options.workspace.openConsolePopup(decision.target, (tabId) => {
          this.popupLoads.set(tabId, {
            postData: data,
            extraHeaders: `Content-Type: ${contentType}${boundary ? `; boundary=${boundary}` : ""}`,
            ...(details.referrer.url ? { httpReferrer: details.referrer } : {}),
          });
        }, sourceTabId).then((result) => {
          if (!result.ok) void this.options.workspace.dispatch({ type: "set-notice", notice: result.error });
        });
      } else {
        void this.options.workspace.dispatch({ type: "open-url", ...decision.target, sourceTabId });
      }
    } else if (decision.kind === "allow-current") {
      this.loadPopupInCurrentView(webContents, url, details);
    } else if (decision.kind === "load-secure-url") {
      this.loadPopupInCurrentView(webContents, decision.url, details);
    } else {
      void this.options.workspace.dispatch({ type: "set-notice", notice: decision.reason });
    }
  }

  private handleNavigationLoad(loading: Promise<void>): void {
    void loading.catch((error: unknown) => {
      const notice = formatConsoleLoadFailure(error);
      if (!notice) return;
      void this.options.workspace.dispatch({
        type: "set-notice",
        notice,
      });
    });
  }

  private handleCurrentNavigation(
    webContents: Electron.WebContents,
    event: Electron.Event,
    url: string,
  ): void {
    const decision = decideNavigation(url, "current", {
      allowTestServer: this.options.allowTestServer,
    });
    if (decision.kind === "allow-current") return;
    event.preventDefault();
    if (decision.kind === "open-console-tab") {
      void this.options.workspace.dispatch({ type: "open-url", ...decision.target });
    } else if (decision.kind === "load-secure-url") {
      this.handleNavigationLoad(webContents.loadURL(decision.url));
    } else {
      void this.options.workspace.dispatch({ type: "set-notice", notice: decision.reason });
    }
  }

  private queueRecycle(): void {
    if (this.destroying) return;
    this.recycleRequested = true;
    if (this.recycleScheduled) return;
    this.recycleScheduled = true;
    this.recycleQueue = this.recycleQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          while (this.recycleRequested && !this.destroying) {
            this.recycleRequested = false;
            try {
              await this.recycleInactiveViews();
            } catch {
              await this.options.workspace.dispatch({
                type: "set-notice",
                notice: "后台页面回收失败，请重新打开应用",
              });
            }
          }
        } finally {
          this.recycleScheduled = false;
          this.recycleRequested = false;
        }
      });
  }

  private startRecycleTimer(): void {
    if (this.recycleTimer) return;
    this.recycleTimer = setInterval(() => this.queueRecycle(), RECYCLE_INTERVAL_MS);
    this.recycleTimer.unref();
  }

  private async runRetryFailedTabs(signal: AbortSignal): Promise<ConsoleRetryResult> {
    const tabIds = this.options.workspace.getSnapshot().tabs
      .filter((tab) => tab.loadState === "error" || tab.loadState === "crashed")
      .map((tab) => tab.id);
    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    for (const tabId of tabIds) {
      await this.recycleQueue;
      if (signal.aborted) break;
      const tab = this.options.workspace.getSnapshot().tabs.find((candidate) => candidate.id === tabId);
      // A failed view may have been recycled while an earlier retry was loading.
      if (!tab || !["error", "crashed", "deferred"].includes(tab.loadState)) continue;
      attempted += 1;
      const navigation = decideNavigation(tab.url, "current", {
        allowTestServer: this.options.allowTestServer,
      });
      if (navigation.kind !== "allow-current") {
        failed += 1;
        continue;
      }
      let managed = this.views.get(tab.id);
      if (!managed || managed.view.webContents.isDestroyed()) {
        if (managed) this.detach(tab.id, managed);
        managed = this.create(tab);
        this.views.set(tab.id, managed);
        this.peakLiveViewCount = Math.max(this.peakLiveViewCount, this.views.size);
        this.recycledTabIds.delete(tab.id);
      }
      this.retryingTabId = tab.id;
      try {
        await this.options.workspace.dispatch({
          type: "update-tab",
          tabId: tab.id,
          loadState: "loading",
        });
        if (signal.aborted) break;
        if (!this.options.workspace.getSnapshot().tabs.some((candidate) => candidate.id === tab.id)) continue;
        await this.loadRetryPage(managed.view.webContents, tab.url, signal);
        succeeded += 1;
      } catch (error) {
        if (signal.aborted) break;
        failed += 1;
        const errorMessage = formatConsoleLoadFailure(error);
        if (!errorMessage) continue;
        await this.options.workspace.dispatch({
          type: "update-tab",
          tabId: tab.id,
          loadState: "error",
          errorMessage,
        });
      } finally {
        this.retryingTabId = null;
        this.queueRecycle();
        await this.recycleQueue;
      }
    }
    if (signal.aborted) return { attempted, succeeded, failed };
    const notice = attempted === 0
      ? "没有需要重试的标签"
      : failed > 0
        ? `已重试 ${attempted} 个标签，${failed} 个仍加载失败`
        : `已重试 ${attempted} 个标签`;
    await this.options.workspace.dispatch({ type: "set-notice", notice });
    return { attempted, succeeded, failed };
  }

  private loadRetryPage(webContents: Electron.WebContents, url: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve();
      };
      const stop = (error: Error) => {
        finish(error);
        if (!webContents.isDestroyed()) webContents.stop();
      };
      const cancel = () => stop(new Error("已取消重试"));
      const timer = setTimeout(() => stop(Object.assign(new Error("ERR_TIMED_OUT"), { errno: -118 })), RETRY_LOAD_TIMEOUT_MS);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      try {
        void webContents.loadURL(url).then(() => finish(), finish);
      } catch (error) {
        finish(error);
      }
    });
  }

  private async recycleInactiveViews(): Promise<void> {
    if (this.views.size <= 4) return;
    const totalWorkingSet = app.getAppMetrics().reduce(
      (total, metric) => total + metric.memory.workingSetSize * 1024,
      0,
    );
    const maxLiveViews = totalWorkingSet === 0 || totalWorkingSet >= PRESSURE_WORKING_SET
      ? 4
      : totalWorkingSet >= MEDIUM_WORKING_SET
        ? 6
        : 8;
    if (this.views.size <= maxLiveViews) return;
    const pinnedTabs = new Set(
      this.options.workspace.getSnapshot().tabs
        .filter((tab) => tab.pinned)
        .map((tab) => tab.id),
    );
    const candidates = [...this.views.values()]
      .filter((managed) => managed.tabId !== this.activeTabId && managed.tabId !== this.retryingTabId)
      .sort((left, right) =>
        Number(pinnedTabs.has(left.tabId)) - Number(pinnedTabs.has(right.tabId))
        || left.lastVisibleAt - right.lastVisibleAt,
      );
    while (this.views.size > maxLiveViews) {
      const candidate = candidates.shift();
      if (!candidate) break;
      this.recyclingTabIds.add(candidate.tabId);
      try {
        if (candidate.tabId === this.activeTabId || candidate.tabId === this.retryingTabId) continue;
        const closed = await this.close(candidate.tabId);
        if (!closed) continue;
        this.recycledViewCount += 1;
        this.recycledTabIds.add(candidate.tabId);
        await this.options.workspace.dispatch({
          type: "update-tab",
          tabId: candidate.tabId,
          loadState: "deferred",
          canGoBack: false,
          canGoForward: false,
        });
      } finally {
        this.recyclingTabIds.delete(candidate.tabId);
      }
    }
  }

  private getShareableUrl(currentUrl: string): string | null {
    if (!parseObservedConsoleTarget(currentUrl, this.options.allowTestServer)) {
      void this.options.workspace.dispatch({
        type: "set-notice",
        notice: "登录或外部页面链接不能复制或在系统浏览器中打开",
      });
      return null;
    }

    const savedUrl = this.options.workspace
      .getSnapshot()
      .tabs.find((tab) => tab.id === this.activeTabId)?.url;
    return savedUrl && parseObservedConsoleTarget(savedUrl, this.options.allowTestServer)
      ? savedUrl
      : currentUrl;
  }

  private detach(tabId: string, managed: ManagedView): void {
    if (
      !this.options.window.isDestroyed() &&
      this.options.window.contentView.children.includes(managed.view)
    ) {
      this.options.window.contentView.removeChildView(managed.view);
    }
    if (this.views.get(tabId) === managed) this.views.delete(tabId);
  }
}
