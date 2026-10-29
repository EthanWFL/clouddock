import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  screen,
  shell,
  systemPreferences,
  type MenuItemConstructorOptions,
} from "electron";
import { IPC_CHANNELS, NativeMenuSchema, ViewActionSchema, ViewBoundsSchema, type NativeMenuAction } from "../shared/ipc";
import type { AppAppearance } from "../shared/api";
import { decideNavigation } from "../shared/navigation-policy";
import { extractConsoleUrls } from "../shared/console-url";
import {
  WorkspaceCommandSchema,
  type WorkspaceSnapshot,
  type WorkspaceTab,
} from "../shared/model";
import { ConsoleSession } from "./modules/console-session/console-session";
import { CredentialStore } from "./modules/console-session/credential-store";
import { ConsoleViews, type ExternalOpener } from "./modules/console-views/console-views";
import { formatDiagnosticSummary } from "./modules/diagnostics/diagnostics";
import {
  APP_PROTOCOL_REGISTRATION,
  APP_RENDERER_URL,
  installAppProtocol,
  selectRendererUrl,
} from "./modules/app-protocol/app-protocol";
import { FileSnapshotStore, migrateWorkspaceSnapshot } from "./modules/workspace/persistence";
import { Workspace } from "./modules/workspace/workspace";
import { formatWorkspaceContext } from "./modules/workspace-context/workspace-context";
import {
  EXTERNAL_OPEN_ALLOWLIST_ENV,
  findExternalOpenUrls,
  parseExternalOpenHostRules,
  registerExternalOpenProtocols,
} from "./modules/external-open/external-open";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
const allowTestServer = __OPSDOCK_E2E__ && !app.isPackaged;
const rendererUrl = selectRendererUrl(app.isPackaged, process.env.ELECTRON_RENDERER_URL);
const SHELL_RECOVERY_LIMIT = 2;
const SHELL_RECOVERY_TIMEOUT_MS = 8_000;
const SHELL_STABLE_RESET_MS = 30_000;

function windowBackgroundColor(): string {
  if (process.platform === "darwin") return "#00000000";
  return nativeTheme.shouldUseDarkColors ? "#1e2025" : "#f3f5f7";
}

function normalizeAccentColor(accent: string): string | null {
  const match = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(accent.trim());
  return match ? `#${match[1]}` : null;
}

function appAppearance(): AppAppearance {
  return {
    colorScheme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
    // Chromium's AccentColor system color stays live on macOS without an
    // unsupported accent-color-changed subscription.
    accentColor: null,
  };
}

function notifyAppearanceChanged(accentColor?: string | null): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const appearance = appAppearance();
    mainWindow.webContents.send(IPC_CHANNELS.appearanceChanged, {
      ...appearance,
      accentColor: accentColor === undefined ? appearance.accentColor : accentColor,
    });
  }
}

protocol.registerSchemesAsPrivileged([APP_PROTOCOL_REGISTRATION]);

if (allowTestServer && process.env.OPSDOCK_E2E_USER_DATA) {
  app.setPath("userData", process.env.OPSDOCK_E2E_USER_DATA);
} else {
  // Preserve the pre-1.0 storage location across the user-visible rename.
  app.setPath("userData", join(app.getPath("appData"), "opsdock"));
}

let mainWindow: BrowserWindow | null = null;
let workspace: Workspace | null = null;
let consoleViews: ConsoleViews | null = null;
let consoleSession: ConsoleSession | null = null;
let credentialStore: CredentialStore | null = null;
let unsubscribeWorkspace: (() => void) | null = null;
let pendingActivation: WorkspaceTab | null = null;
let activationRunning = false;
let boundsSaveTimer: ReturnType<typeof setTimeout> | null = null;
let quitReady = false;
let quitCleanup: Promise<void> | null = null;
let logoutRunning = false;
let requestedActiveTabId: string | null = null;
const externalOpenHostRules = parseExternalOpenHostRules(
  process.env[EXTERNAL_OPEN_ALLOWLIST_ENV],
);
const pendingExternalOpenUrls: string[] = [];
let externalOpenRunning = false;

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function queueExternalOpenUrl(url: string): void {
  if (!pendingExternalOpenUrls.includes(url)) pendingExternalOpenUrls.push(url);
  focusMainWindow();
  drainExternalOpenUrls();
}

function drainExternalOpenUrls(): void {
  if (externalOpenRunning || !workspace || quitCleanup || logoutRunning) return;
  externalOpenRunning = true;
  void (async () => {
    while (workspace && !quitCleanup && !logoutRunning && pendingExternalOpenUrls.length > 0) {
      const requestUrl = pendingExternalOpenUrls.shift()!;
      const result = await workspace.openExternalUrl(requestUrl, externalOpenHostRules);
      if (!result.ok) {
        await workspace.dispatch({ type: "set-notice", notice: result.error });
      }
    }
  })().finally(() => {
    externalOpenRunning = false;
    focusMainWindow();
    if (pendingExternalOpenUrls.length > 0) drainExternalOpenUrls();
  });
}

function isTrustedShellEvent(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
): boolean {
  const shellContents = mainWindow?.webContents;
  return Boolean(
    shellContents &&
      !shellContents.isDestroyed() &&
      event.sender === shellContents &&
      event.senderFrame === shellContents.mainFrame,
  );
}

function assertTrustedShellEvent(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
): void {
  if (!isTrustedShellEvent(event)) throw new Error("拒绝未授权的应用调用");
}

function requestActivation(tab: WorkspaceTab): void {
  if (quitCleanup || logoutRunning) return;
  pendingActivation = tab;
  if (activationRunning) return;
  activationRunning = true;
  void (async () => {
    while (pendingActivation) {
      const next = pendingActivation;
      pendingActivation = null;
      try {
        await consoleViews?.activate(next);
      } catch (error) {
        await workspace?.dispatch({
          type: "update-tab",
          tabId: next.id,
          loadState: "error",
          errorMessage: error instanceof Error ? error.message : "控制台页面加载失败",
        });
      }
    }
  })().finally(() => {
    activationRunning = false;
    if (pendingActivation) requestActivation(pendingActivation);
  });
}

const failedProtocolRegistrations = registerExternalOpenProtocols(app);
if (failedProtocolRegistrations.length > 0) {
  console.error(
    `CloudDock 协议注册失败：${failedProtocolRegistrations.join(", ")}`,
  );
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    for (const url of findExternalOpenUrls(commandLine)) queueExternalOpenUrl(url);
    focusMainWindow();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    queueExternalOpenUrl(url);
  });
  for (const url of findExternalOpenUrls(process.argv)) queueExternalOpenUrl(url);
}

function createApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "窗口",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function visibleWindowBounds(snapshot: WorkspaceSnapshot): Electron.Rectangle {
  const requested = snapshot.windowBounds;
  const display = screen.getDisplayMatching({
    x: requested.x ?? 0,
    y: requested.y ?? 0,
    width: requested.width,
    height: requested.height,
  });
  const area = display.workArea;
  const width = Math.min(Math.max(requested.width, 1024), area.width);
  const height = Math.min(Math.max(requested.height, 680), area.height);
  const x = Math.min(
    Math.max(requested.x ?? area.x + Math.round((area.width - width) / 2), area.x),
    area.x + area.width - width,
  );
  const y = Math.min(
    Math.max(requested.y ?? area.y + Math.round((area.height - height) / 2), area.y),
    area.y + area.height - height,
  );
  return { x, y, width, height };
}

function createExternalOpener(): ExternalOpener {
  return {
    async open(urlValue) {
      const url = new URL(urlValue);
      if (url.protocol !== "https:") throw new Error("只允许打开 HTTPS 外部链接");
      if (allowTestServer) return;
      await shell.openExternal(url.toString());
    },
  };
}

async function createMainWindow(): Promise<void> {
  const statePath = join(app.getPath("userData"), "workspace.json");
  const restoredWorkspace = new Workspace({
    store: new FileSnapshotStore({ filePath: statePath, migrate: migrateWorkspaceSnapshot }),
    allowTestServer,
    externalOpenHostRules,
  });
  const snapshot = await restoredWorkspace.restore();
  workspace = restoredWorkspace;
  const initialBounds = visibleWindowBounds(snapshot);

  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: "CloudDock",
    backgroundColor: windowBackgroundColor(),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          transparent: true,
          vibrancy: "sidebar" as const,
          visualEffectState: "followWindow" as const,
        }
      : {}),
    webPreferences: {
      preload: join(currentDirectory, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.on("will-redirect", (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const shellContents = mainWindow.webContents;
  let shellRecoveryAttempts = 0;
  let shellRecovering = false;
  let shellRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let shellStableTimer: ReturnType<typeof setTimeout> | null = null;
  let shellRecoveryLimitReported = false;
  const clearShellTimer = (timer: ReturnType<typeof setTimeout> | null) => {
    if (timer) clearTimeout(timer);
  };
  const recoverShell = (reason: string) => {
    if (shellContents.isDestroyed() || shellRecovering) return;
    if (shellRecoveryAttempts >= SHELL_RECOVERY_LIMIT) {
      if (!shellRecoveryLimitReported) {
        shellRecoveryLimitReported = true;
        void workspace?.dispatch({
          type: "set-notice",
          notice: "应用界面持续无响应，请重新启动 CloudDock",
        });
      }
      return;
    }
    shellRecoveryAttempts += 1;
    shellRecovering = true;
    clearShellTimer(shellRecoveryTimer);
    shellContents.reload();
    shellRecoveryTimer = setTimeout(() => {
      shellRecoveryTimer = null;
      shellRecovering = false;
      recoverShell(reason);
    }, SHELL_RECOVERY_TIMEOUT_MS);
  };
  shellContents.on("unresponsive", () => recoverShell("应用界面无响应"));
  shellContents.on("responsive", () => {
    if (shellRecovering) return;
    clearShellTimer(shellStableTimer);
    shellStableTimer = setTimeout(() => {
      shellRecoveryAttempts = 0;
      shellRecoveryLimitReported = false;
    }, SHELL_STABLE_RESET_MS);
  });
  shellContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    shellRecovering = false;
    recoverShell("应用界面进程异常退出");
  });
  shellContents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    recoverShell("应用界面加载失败");
  });
  shellContents.on("did-finish-load", () => {
    const recovered = shellRecoveryAttempts > 0;
    shellRecovering = false;
    clearShellTimer(shellRecoveryTimer);
    shellRecoveryTimer = null;
    clearShellTimer(shellStableTimer);
    shellStableTimer = setTimeout(() => {
      shellRecoveryAttempts = 0;
      shellRecoveryLimitReported = false;
    }, SHELL_STABLE_RESET_MS);
    if (recovered) {
      void workspace?.dispatch({ type: "set-notice", notice: "应用界面已自动恢复" });
    }
  });

  consoleSession = new ConsoleSession({
    allowTestServer,
    onDownloadBlocked: () => {
      void workspace?.dispatch({
        type: "set-notice",
        notice: "仅允许从阿里云控制台页面下载文件",
      });
    },
    onDownloadStatus: (status) => {
      const notice = status.type === "started"
        ? `开始下载：${status.fileName}`
        : status.type === "progress"
          ? `正在下载 ${status.fileName}：${status.percent}%`
          : status.type === "completed"
            ? `下载完成：${status.fileName}`
            : status.type === "cancelled"
              ? `已取消下载：${status.fileName}`
              : `下载失败：${status.fileName}`;
      void workspace?.dispatch({ type: "set-notice", notice });
    },
  });
  credentialStore = new CredentialStore(join(app.getPath("userData"), "login-credentials.json"));
  consoleSession.installPolicies();

  consoleViews = new ConsoleViews({
    window: mainWindow,
    workspace,
    session: consoleSession,
    credentialStore,
    autofillPreload: join(currentDirectory, "../preload/login-autofill.js"),
    externalOpener: createExternalOpener(),
    onShortcut: (shortcut) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.consoleShortcut, shortcut);
      }
    },
    allowTestServer,
    enableDevTools: process.env.OPSDOCK_DEVTOOLS === "1",
  });

  mainWindow.on("resize", scheduleWindowBoundsSave);
  mainWindow.on("move", scheduleWindowBoundsSave);
  mainWindow.on("close", (event) => {
    if (quitReady) return;
    event.preventDefault();
    app.quit();
  });
  mainWindow.on("closed", () => {
    clearShellTimer(shellRecoveryTimer);
    clearShellTimer(shellStableTimer);
    unsubscribeWorkspace?.();
    unsubscribeWorkspace = null;
    mainWindow = null;
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());

  await mainWindow.loadURL(rendererUrl);

  unsubscribeWorkspace = workspace.subscribe((nextSnapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.workspaceChanged, nextSnapshot);
    }
    const activeTab = nextSnapshot.tabs.find((tab) => tab.id === nextSnapshot.activeTabId);
    if (!activeTab) {
      requestedActiveTabId = null;
    } else if (consoleViews && activeTab.id !== requestedActiveTabId) {
      requestedActiveTabId = activeTab.id;
      requestActivation(activeTab);
    }
  });
}

function scheduleWindowBoundsSave(): void {
  if (!mainWindow || !workspace || mainWindow.isDestroyed()) return;
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    if (!mainWindow || !workspace || mainWindow.isDestroyed() || mainWindow.isFullScreen()) return;
    const bounds = mainWindow.getBounds();
    void workspace.dispatch({ type: "set-window-bounds", bounds });
  }, 250);
}

async function prepareToQuit(): Promise<void> {
  const failures: unknown[] = [];
  if (boundsSaveTimer) {
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = null;
  }
  if (mainWindow && workspace && !mainWindow.isDestroyed() && !mainWindow.isFullScreen()) {
    try {
      const result = await workspace.dispatch({
        type: "set-window-bounds",
        bounds: mainWindow.getBounds(),
      });
      if (!result.ok) failures.push(new Error(result.error));
    } catch (error) {
      failures.push(error);
    }
  }
  await consoleViews?.destroyAll(false);
  try {
    await workspace?.flush();
  } catch (error) {
    failures.push(error);
  }
  try {
    await consoleSession?.flushCookies();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "退出清理未完整完成");
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.nativeMenu, (event, input) => {
    assertTrustedShellEvent(event);
    const request = NativeMenuSchema.parse(input);
    const window = mainWindow;
    if (!window || !workspace || quitCleanup || logoutRunning) return null;
    const snapshot = workspace.getSnapshot();
    return new Promise<NativeMenuAction | null>((resolve) => {
      const item = (label: string, action: NativeMenuAction, enabled = true): MenuItemConstructorOptions => ({
        label, enabled, click: () => resolve(action),
      });
      let template: MenuItemConstructorOptions[];
      if (request.type === "app") {
        template = [
          item("记住账号密码…", "credentials"),
          item("复制诊断摘要", "diagnostics"),
          { type: "separator" },
          item("退出 RAM 登录…", "logout"),
        ];
      } else {
        const shortcut = request.type === "module-shortcut"
          ? snapshot.moduleShortcuts.find((candidate) => candidate.id === request.id)
          : null;
        const items = request.type === "favorite"
          ? snapshot.favorites
          : snapshot.moduleShortcuts.filter((candidate) => candidate.product === shortcut?.product);
        const index = items.findIndex((candidate) => candidate.id === request.id);
        if (index < 0) { resolve(null); return; }
        template = [
          item("重命名…", "rename"),
          item("上移", "move-up", index > 0),
          item("下移", "move-down", index < items.length - 1),
          { type: "separator" },
          item("删除", "remove"),
        ];
      }
      Menu.buildFromTemplate(template).popup({ window, callback: () => resolve(null) });
    });
  });
  ipcMain.handle(IPC_CHANNELS.appearanceGet, (event) => {
    assertTrustedShellEvent(event);
    return appAppearance();
  });
  ipcMain.handle(IPC_CHANNELS.workspaceGet, (event) => {
    assertTrustedShellEvent(event);
    return workspace?.getSnapshot();
  });
  ipcMain.handle(IPC_CHANNELS.workspaceDispatch, async (event, input) => {
    assertTrustedShellEvent(event);
    if (!workspace) throw new Error("工作区尚未初始化");
    if (quitCleanup || logoutRunning) throw new Error("正在退出或清理会话，请稍后再试");
    const command = WorkspaceCommandSchema.parse(input);
    if (command.type === "open-url") {
      const decision = decideNavigation(command.url, "popup", { allowTestServer });
      if (decision.kind !== "open-console-tab") {
        throw new Error("只允许打开受信任的阿里云控制台链接");
      }
      if (
        !allowTestServer &&
        (decision.target.product !== command.product || decision.target.regionId !== command.regionId)
      ) {
        throw new Error("控制台链接与产品或地域不匹配");
      }
    }
    if (command.type === "close-tabs") {
      if (!consoleViews) throw new Error("控制台页面尚未就绪");
      const activeTabId = workspace.getSnapshot().activeTabId;
      const tabIds = workspace.getBatchCloseTabIds(command.scope).sort((left, right) =>
        Number(left === activeTabId) - Number(right === activeTabId));
      const closedTabIds: string[] = [];
      let blockedCount = 0;
      let result;
      try {
        for (const tabId of tabIds) {
          if (!(await consoleViews.close(tabId))) {
            blockedCount += 1;
            continue;
          }
          closedTabIds.push(tabId);
        }
      } finally {
        // Even if a later page fails to close, commit the pages already destroyed.
        result = await workspace.closeTabs(closedTabIds);
      }
      if (!result.ok) return result;
      const closedCount = closedTabIds.length;
      const summary = blockedCount > 0
        ? `已关闭 ${closedCount} 个标签，${blockedCount} 个页面阻止关闭`
        : `已关闭 ${closedCount} 个标签`;
      return workspace.dispatch({ type: "set-notice", notice: summary });
    }
    if (command.type === "close-tab" && consoleViews) {
      const closed = await consoleViews.close(command.tabId);
      if (!closed) {
        return workspace.dispatch({
          type: "set-notice",
          notice: "页面阻止关闭，请先完成或取消当前操作",
        });
      }
    }
    return workspace.dispatch(command);
  });
  ipcMain.on(IPC_CHANNELS.viewBounds, (event, input) => {
    if (!isTrustedShellEvent(event)) return;
    const parsed = ViewBoundsSchema.safeParse(input);
    if (!parsed.success) return;
    consoleViews?.setBounds(parsed.data, parsed.data.visible);
  });
  ipcMain.handle(IPC_CHANNELS.viewAction, async (event, input) => {
    assertTrustedShellEvent(event);
    if (quitCleanup || logoutRunning) return null;
    const action = ViewActionSchema.parse(input);
    return await consoleViews?.perform(action) ?? null;
  });
  ipcMain.handle(IPC_CHANNELS.diagnosticsCopy, async (event) => {
    assertTrustedShellEvent(event);
    if (!workspace || !consoleViews) throw new Error("诊断信息尚未就绪");
    const snapshot = workspace.getSnapshot();
    const processMetrics = app.getAppMetrics();
    const summary = formatDiagnosticSummary({
      ...consoleViews.performanceDiagnostics(),
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      macOSVersion: process.getSystemVersion(),
      architecture: process.arch,
      tabCount: snapshot.tabs.length,
      liveViewCount: consoleViews
        .diagnostics(snapshot.tabs)
        .filter((view) => view.created && !view.destroyed).length,
      processCount: processMetrics.length,
      totalWorkingSetBytes: processMetrics.reduce(
        (total, metric) => total + metric.memory.workingSetSize * 1024,
        0,
      ),
    });
    clipboard.writeText(summary);
    await workspace.dispatch({ type: "set-notice", notice: "诊断摘要已复制" });
  });
  ipcMain.handle(IPC_CHANNELS.workspaceContextCopy, async (event) => {
    assertTrustedShellEvent(event);
    if (!workspace) throw new Error("工作区尚未初始化");
    clipboard.writeText(formatWorkspaceContext(workspace.getSnapshot()));
    await workspace.dispatch({ type: "set-notice", notice: "工作区上下文已复制" });
  });
  ipcMain.handle(IPC_CHANNELS.retryFailedTabs, async (event) => {
    assertTrustedShellEvent(event);
    if (!consoleViews) throw new Error("控制台页面尚未就绪");
    if (quitCleanup || logoutRunning) throw new Error("正在退出或清理会话，请稍后再试");
    return consoleViews.retryFailedTabs();
  });
  ipcMain.handle(IPC_CHANNELS.sessionLogout, async (event) => {
    assertTrustedShellEvent(event);
    if (!workspace || !consoleViews || !consoleSession) {
      throw new Error("控制台会话尚未初始化");
    }
    if (quitCleanup || logoutRunning) throw new Error("正在退出或清理会话，请稍后再试");
    logoutRunning = true;
    pendingActivation = null;
    try {
      await consoleViews.destroyAll();
      await consoleSession.clearLoginState();
      return await workspace.dispatch({ type: "clear-console-tabs" });
    } catch (error) {
      await consoleViews.restoreActiveView().catch(() => workspace?.dispatch({ type: "set-notice", notice: "页面恢复失败，请刷新或重新打开标签" }));
      throw error;
    } finally {
      logoutRunning = false;
      drainExternalOpenUrls();
    }
  });
  ipcMain.handle(IPC_CHANNELS.credentialsGet, async (event) => {
    assertTrustedShellEvent(event);
    return credentialStore?.status() ?? { configured: false, username: null };
  });
  ipcMain.handle(IPC_CHANNELS.credentialsSave, async (event, input) => {
    assertTrustedShellEvent(event);
    const credentials = z.object({ username: z.string().trim().min(1).max(256), password: z.string().min(1).max(1_024) }).parse(input);
    if (!credentialStore) throw new Error("登录信息存储尚未初始化");
    await credentialStore.save(credentials);
    await consoleViews?.fillActiveLoginCredentials();
    return credentialStore.status();
  });
  ipcMain.handle(IPC_CHANNELS.credentialsClear, async (event) => {
    assertTrustedShellEvent(event);
    await credentialStore?.clear();
    return { configured: false, username: null };
  });
  ipcMain.handle(IPC_CHANNELS.clipboardConsoleUrls, (event) => {
    assertTrustedShellEvent(event);
    const value = clipboard.readText();
    if (!value || value.length > 32_768) return [];
    return extractConsoleUrls(value);
  });
  ipcMain.handle(IPC_CHANNELS.appVersion, (event) => {
    assertTrustedShellEvent(event);
    return app.getVersion();
  });
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = "system";
  nativeTheme.on("updated", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(windowBackgroundColor());
    }
    notifyAppearanceChanged();
  });
  if (process.platform === "win32" || process.platform === "linux") {
    systemPreferences.on("accent-color-changed", (_event, newColor) => {
      notifyAppearanceChanged(normalizeAccentColor(newColor));
    });
  }
  app.setName("CloudDock");
  app.setAppUserModelId("io.github.wuerlong.clouddock");
  app.setAboutPanelOptions({
    applicationName: "CloudDock",
    applicationVersion: app.getVersion(),
    copyright: "Personal operations workspace",
  });
  if (rendererUrl === APP_RENDERER_URL) {
    installAppProtocol(protocol, join(currentDirectory, "../renderer"));
  }
  createApplicationMenu();
  registerIpc();
  await createMainWindow();
  drainExternalOpenUrls();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createMainWindow();
  });
});

app.on("before-quit", (event) => {
  if (quitReady) return;
  event.preventDefault();
  if (logoutRunning) return;
  pendingActivation = null;
  quitCleanup ??= prepareToQuit()
    .then(() => {
      quitReady = true;
      app.quit();
    })
    .catch(async (error: unknown) => {
      let notice = error instanceof Error ? `退出已取消：${error.message}` : "退出未完成，请重试";
      try {
        await consoleViews?.restoreActiveView();
      } catch {
        notice += "；页面恢复失败，请刷新或重新打开标签";
      }
      await workspace?.dispatch({ type: "set-notice", notice });
      focusMainWindow();
    })
    .finally(() => {
      quitCleanup = null;
      if (!quitReady) drainExternalOpenUrls();
    });
});

app.on("window-all-closed", () => app.quit());
