import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { HandlerDetails } from "electron";

import type { WorkspaceSnapshot, WorkspaceTab } from "../../src/shared/model";
import type { ConsoleSession } from "../../src/main/modules/console-session/console-session";
import type { Workspace } from "../../src/main/modules/workspace/workspace";

const electronMocks = vi.hoisted(() => ({
  writeText: vi.fn(),
  workingSetSizeKb: 0,
  getAppMetrics: vi.fn(),
  menuTemplates: [] as unknown[][],
  popupMenu: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppMetrics: () => {
      electronMocks.getAppMetrics();
      return [{ memory: { workingSetSize: electronMocks.workingSetSizeKb } }];
    },
  },
  clipboard: { writeText: electronMocks.writeText },
  Menu: {
    buildFromTemplate: vi.fn((template: unknown[]) => {
      electronMocks.menuTemplates.push(template);
      return { popup: electronMocks.popupMenu };
    }),
  },
  WebContentsView: class WebContentsView {},
}));

import { ConsoleViews } from "../../src/main/modules/console-views/console-views";

const SAVED_URL =
  "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing";
const CURRENT_URL =
  "https://cs.console.aliyun.com/#/k8s/cluster/detail?clusterId=cluster-current&region=cn-beijing";
const FLOW_URL = "https://flow.aliyun.com/pipelines/123";

afterEach(() => vi.useRealTimers());

function createTab(url = SAVED_URL): WorkspaceTab {
  return {
    id: "tab-1",
    product: "ack",
    regionId: "cn-beijing",
    url,
    title: "ACK",
    createdAt: 1,
    lastActiveAt: 1,
    pinned: false,
    taskStatus: null,
    loadState: "ready",
    canGoBack: false,
    canGoForward: false,
  };
}

function createHarness(currentUrl: string, savedUrl = SAVED_URL) {
  const open = vi.fn(async () => undefined);
  const dispatch = vi.fn(async () => ({ ok: true as const, snapshot: {} as WorkspaceSnapshot }));
  const snapshot = { tabs: [createTab(savedUrl)] } as WorkspaceSnapshot;
  const workspace = {
    getSnapshot: () => snapshot,
    dispatch,
  } as unknown as Workspace;
  const consoleViews = new ConsoleViews({
    window: { focus: vi.fn(), webContents: { focus: vi.fn() } } as never,
    workspace,
    session: {} as ConsoleSession,
    autofillPreload: "/login-autofill.js",
    externalOpener: { open },
    onShortcut: vi.fn(),
  });
  const webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      getURL: () => currentUrl,
      findInPage: vi.fn(() => 1),
      stopFindInPage: vi.fn(),
      focus: vi.fn(),
    });
  const view = {
    webContents,
  };
  Reflect.set(consoleViews, "activeTabId", "tab-1");
  Reflect.set(
    consoleViews,
    "views",
    new Map([
      ["tab-1", { view, tabId: "tab-1", lastVisibleAt: 1 }],
    ]),
  );
  return { consoleViews, dispatch, open, webContents };
}

function createNavigationHarness() {
  const dispatch = vi.fn(async () => ({ ok: true as const, snapshot: {} as WorkspaceSnapshot }));
  const open = vi.fn(async () => undefined);
  const workspace = {
    getSnapshot: () => ({ tabs: [createTab()] }) as WorkspaceSnapshot,
    dispatch,
  } as unknown as Workspace;
  const consoleViews = new ConsoleViews({
    window: {} as never,
    workspace,
    session: {} as ConsoleSession,
    autofillPreload: "/login-autofill.js",
    externalOpener: { open },
    onShortcut: vi.fn(),
  });
  let currentUrl = SAVED_URL;
  let windowOpenHandler: ((details: HandlerDetails) => { action: "deny" }) | null = null;
  const webContents = Object.assign(new EventEmitter(), {
    getURL: () => currentUrl,
    isDestroyed: () => false,
    loadURL: vi.fn(async (url: string) => {
      currentUrl = url;
    }),
    navigationHistory: {
      canGoBack: () => true,
      canGoForward: () => false,
    },
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    reload: vi.fn(),
    setWindowOpenHandler: vi.fn((handler: typeof windowOpenHandler) => {
      windowOpenHandler = handler;
    }),
  });
  const attachEvents = Reflect.get(consoleViews, "attachEvents") as (
    tabId: string,
    view: unknown,
  ) => void;
  attachEvents.call(consoleViews, "tab-1", { webContents });

  return {
    dispatch,
    open,
    webContents,
    openContextMenu(params: {
      linkURL?: string;
      editFlags?: Partial<{ canCopy: boolean; canPaste: boolean; canSelectAll: boolean }>;
    }) {
      const event = { preventDefault: vi.fn() };
      webContents.emit("context-menu", event, {
        linkURL: "",
        editFlags: { canCopy: false, canPaste: false, canSelectAll: false },
        ...params,
        ...(params.editFlags
          ? {
              editFlags: {
                canCopy: false,
                canPaste: false,
                canSelectAll: false,
                ...params.editFlags,
              },
            }
          : {}),
      });
      return event;
    },
    setCurrentUrl(url: string) {
      currentUrl = url;
    },
    openPopup(url: string, overrides: Partial<HandlerDetails> = {}) {
      if (!windowOpenHandler) throw new Error("Window open handler was not installed");
      return windowOpenHandler({
        url,
        frameName: "",
        features: "",
        disposition: "new-window",
        referrer: { url: "", policy: "default" },
        ...overrides,
      });
    },
  };
}

describe("ConsoleViews.perform shareable URL actions", () => {
  it("returns focus to the active view only when closing the find bar requests it", async () => {
    const { consoleViews, webContents } = createHarness(CURRENT_URL);
    await consoleViews.perform({ type: "stop-find" });
    expect(webContents.focus).not.toHaveBeenCalled();
    await consoleViews.perform({ type: "stop-find", restoreFocus: true });
    expect(webContents.focus).toHaveBeenCalledOnce();
  });

  it("cancels a pending find when replaced or stopped and ignores obsolete results", async () => {
    const { consoleViews, webContents } = createHarness(CURRENT_URL);
    webContents.findInPage.mockReturnValueOnce(1).mockReturnValueOnce(2);
    const previous = consoleViews.perform({ type: "find", text: "old", forward: true, findNext: false });
    const next = consoleViews.perform({ type: "find", text: "new", forward: false, findNext: true });
    await expect(previous).resolves.toBeNull();
    expect(webContents.findInPage).toHaveBeenLastCalledWith("new", { forward: false, findNext: false });
    webContents.emit("found-in-page", {}, { requestId: 1, matches: 99, finalUpdate: true });
    await consoleViews.perform({ type: "stop-find" });
    await expect(next).resolves.toBeNull();
    expect(webContents.listenerCount("found-in-page")).toBe(0);
    expect(webContents.listenerCount("destroyed")).toBe(0);
  });

  beforeEach(() => {
    electronMocks.writeText.mockReset();
    electronMocks.workingSetSizeKb = 0;
    electronMocks.menuTemplates.length = 0;
    electronMocks.popupMenu.mockReset();
  });

  it.each([
    "account.aliyun.com",
    "signin.aliyun.com",
    "login.aliyun.com",
    "passport.aliyun.com",
    "account-devops.aliyun.com",
  ])("rejects copy-link while the current WebContents is on %s", async (host) => {
    const { consoleViews, dispatch, open } = createHarness(
      `https://${host}/login?redirect=${encodeURIComponent(SAVED_URL)}`,
    );

    await consoleViews.perform({ type: "copy-link" });

    expect(electronMocks.writeText).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "set-notice",
      notice: "登录或外部页面链接不能复制或在系统浏览器中打开",
    });
  });

  it.each([
    "account.aliyun.com",
    "signin.aliyun.com",
    "login.aliyun.com",
    "passport.aliyun.com",
    "account-devops.aliyun.com",
  ])("rejects open-system while the current WebContents is on %s", async (host) => {
    const { consoleViews, dispatch, open } = createHarness(
      `https://${host}/login?redirect=${encodeURIComponent(SAVED_URL)}`,
    );

    await consoleViews.perform({ type: "open-system" });

    expect(open).not.toHaveBeenCalled();
    expect(electronMocks.writeText).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "set-notice",
      notice: "登录或外部页面链接不能复制或在系统浏览器中打开",
    });
  });

  it("copies the stable Workspace URL instead of the observed WebContents URL", async () => {
    const { consoleViews } = createHarness(CURRENT_URL);

    await consoleViews.perform({ type: "copy-link" });

    expect(electronMocks.writeText).toHaveBeenCalledOnce();
    expect(electronMocks.writeText).toHaveBeenCalledWith(SAVED_URL);
  });

  it("opens the stable Workspace URL instead of the observed WebContents URL", async () => {
    const { consoleViews, open } = createHarness(CURRENT_URL);

    await consoleViews.perform({ type: "open-system" });

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(SAVED_URL);
  });

  it("finds text in the active page and clears the selection", async () => {
    const { consoleViews, webContents } = createHarness(CURRENT_URL);

    const finding = consoleViews.perform({
      type: "find",
      text: "集群",
      forward: true,
      findNext: false,
    });
    webContents.emit("found-in-page", {}, { requestId: 2, activeMatchOrdinal: 8, matches: 8, finalUpdate: true });
    webContents.emit("found-in-page", {}, { requestId: 1, activeMatchOrdinal: 1, matches: 1, finalUpdate: false });
    webContents.emit("found-in-page", {}, { requestId: 1, activeMatchOrdinal: 1, matches: 3, finalUpdate: true });
    const result = await finding;
    expect(result).toEqual({
      tabId: "tab-1",
      text: "集群",
      activeMatchOrdinal: 1,
      matches: 3,
    });
    expect(webContents.findInPage).toHaveBeenCalledWith("集群", { forward: true, findNext: true });
    expect(webContents.listenerCount("found-in-page")).toBe(0);
    await consoleViews.perform({ type: "stop-find" });
    expect(webContents.stopFindInPage).toHaveBeenCalledWith("clearSelection");
  });
});

describe("retry cancellation and timeout", () => {
  function retryHarness() {
    let tabs = [
      { ...createTab(), id: "first", loadState: "error" as const },
      { ...createTab(), id: "second", loadState: "error" as const },
    ];
    const dispatch = vi.fn(async () => ({ ok: true as const, snapshot: {} as WorkspaceSnapshot }));
    const consoleViews = new ConsoleViews({
      window: {} as never,
      workspace: { getSnapshot: () => ({ tabs }), dispatch } as unknown as Workspace,
      session: {} as ConsoleSession,
      autofillPreload: "/login-autofill.js",
      externalOpener: { open: vi.fn() },
      onShortcut: vi.fn(),
    });
    const first = { isDestroyed: () => false, loadURL: vi.fn(() => new Promise<void>(() => {})), stop: vi.fn() };
    const second = { isDestroyed: () => false, loadURL: vi.fn(async () => undefined), stop: vi.fn() };
    const views = new Map([
      ["first", { tabId: "first", view: { webContents: first }, lastVisibleAt: 1 }],
      ["second", { tabId: "second", view: { webContents: second }, lastVisibleAt: 1 }],
    ]);
    Reflect.set(consoleViews, "views", views);
    vi.spyOn(consoleViews, "close").mockImplementation(async (tabId) => { views.delete(tabId); return true; });
    return { consoleViews, dispatch, first, second, removeSecond: () => { tabs = tabs.filter((tab) => tab.id !== "second"); views.delete("second"); } };
  }

  it("cancels a hanging load before destroying views during logout or exit", async () => {
    const { consoleViews, first, second } = retryHarness();
    const retry = consoleViews.retryFailedTabs();
    await vi.waitFor(() => expect(first.loadURL).toHaveBeenCalledOnce());
    await consoleViews.destroyAll();
    await retry;
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.loadURL).not.toHaveBeenCalled();
  });

  it("times out one page and continues to the next", async () => {
    vi.useFakeTimers();
    const { consoleViews, dispatch, first, second } = retryHarness();
    const retry = consoleViews.retryFailedTabs();
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(retry).resolves.toEqual({ attempted: 2, succeeded: 1, failed: 1 });
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.loadURL).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ tabId: "first", errorMessage: expect.stringContaining("-118") }));
    await consoleViews.destroyAll();
  });

  it("does not recreate a tab closed while an earlier retry is loading", async () => {
    vi.useFakeTimers();
    const { consoleViews, first, second, removeSecond } = retryHarness();
    let resolve!: () => void;
    first.loadURL.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    const retry = consoleViews.retryFailedTabs();
    await vi.advanceTimersByTimeAsync(0);
    removeSecond();
    resolve();
    await expect(retry).resolves.toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(second.loadURL).not.toHaveBeenCalled();
    await consoleViews.destroyAll();
  });
});

describe("ConsoleViews native context menu", () => {
  beforeEach(() => {
    electronMocks.menuTemplates.length = 0;
    electronMocks.popupMenu.mockReset();
    electronMocks.writeText.mockReset();
  });

  it("shows only editing actions allowed by the remote context", () => {
    const harness = createNavigationHarness();

    const event = harness.openContextMenu({
      editFlags: { canCopy: true, canPaste: false, canSelectAll: true },
    });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    const template = electronMocks.menuTemplates[0] as Array<{
      label?: string;
      click?: () => void;
    }>;
    expect(template.map((item) => item.label)).toEqual(["复制", "全选"]);
    template[0]?.click?.();
    template[1]?.click?.();
    expect(harness.webContents.copy).toHaveBeenCalledOnce();
    expect(harness.webContents.paste).not.toHaveBeenCalled();
    expect(harness.webContents.selectAll).toHaveBeenCalledOnce();
    expect(electronMocks.popupMenu).toHaveBeenCalledOnce();
  });

  it("pastes only when the editable context allows it", () => {
    const harness = createNavigationHarness();

    harness.openContextMenu({ editFlags: { canPaste: true } });

    const template = electronMocks.menuTemplates[0] as Array<{
      label?: string;
      click?: () => void;
    }>;
    expect(template.map((item) => item.label)).toEqual(["粘贴"]);
    template[0]?.click?.();
    expect(harness.webContents.paste).toHaveBeenCalledOnce();
  });

  it("routes link actions through the existing popup navigation policy", () => {
    const harness = createNavigationHarness();

    harness.openContextMenu({ linkURL: FLOW_URL });

    const template = electronMocks.menuTemplates[0] as Array<{
      label?: string;
      click?: () => void;
    }>;
    expect(template.map((item) => item.label)).toEqual(["在新标签页打开", "复制链接地址"]);
    template[0]?.click?.();
    template[1]?.click?.();
    expect(harness.dispatch).toHaveBeenCalledWith({
      type: "open-url",
      product: "codeup",
      regionId: null,
      url: FLOW_URL,
      sourceTabId: "tab-1",
    });
    expect(electronMocks.writeText).toHaveBeenCalledWith(FLOW_URL);
    expect(harness.open).not.toHaveBeenCalled();
  });

  it("does not expose link actions for authentication or unknown HTTPS pages", () => {
    const harness = createNavigationHarness();

    harness.openContextMenu({ linkURL: "https://signin.aliyun.com/login.htm" });
    harness.openContextMenu({ linkURL: "https://example.com/unknown" });

    expect(electronMocks.menuTemplates).toHaveLength(0);
    expect(electronMocks.popupMenu).not.toHaveBeenCalled();
    expect(electronMocks.writeText).not.toHaveBeenCalled();
  });

  it("does not expose a link action for blocked protocols", () => {
    const harness = createNavigationHarness();

    harness.openContextMenu({ linkURL: "javascript:alert(1)" });

    expect(electronMocks.menuTemplates).toHaveLength(0);
    expect(electronMocks.popupMenu).not.toHaveBeenCalled();
    expect(harness.open).not.toHaveBeenCalled();
  });
});

describe("ConsoleViews login autofill", () => {
  it("fills the active auth view when credentials are saved after page load", async () => {
    const credentials = { username: "ram-user", password: "secret" };
    const get = vi.fn(async () => credentials);
    const send = vi.fn();
    const consoleViews = new ConsoleViews({
      window: {} as never,
      workspace: {} as Workspace,
      session: {} as ConsoleSession,
      credentialStore: { get } as never,
      autofillPreload: "/login-autofill.js",
      externalOpener: { open: vi.fn(async () => undefined) },
      onShortcut: vi.fn(),
    });
    Reflect.set(consoleViews, "activeTabId", "auth-tab");
    Reflect.set(consoleViews, "views", new Map([
      ["auth-tab", {
        tabId: "auth-tab",
        lastVisibleAt: 1,
        view: {
          webContents: {
            getURL: () => "https://account.aliyun.com/login",
            isDestroyed: () => false,
            send,
          },
        },
      }],
    ]));

    await consoleViews.fillActiveLoginCredentials();

    expect(get).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("credentials:fill", credentials);
  });

  it("sends structured credentials only to an exact HTTPS auth host", async () => {
    const credentials = { username: "ram-user", password: "secret" };
    const get = vi.fn(async () => credentials);
    const consoleViews = new ConsoleViews({
      window: {} as never,
      workspace: {} as Workspace,
      session: {} as ConsoleSession,
      credentialStore: { get } as never,
      autofillPreload: "/login-autofill.js",
      externalOpener: { open: vi.fn(async () => undefined) },
      onShortcut: vi.fn(),
    });
    const send = vi.fn();
    const fill = Reflect.get(consoleViews, "fillLoginCredentials") as (
      webContents: unknown,
    ) => Promise<void>;

    await fill.call(consoleViews, {
      getURL: () => "https://account.aliyun.com/login",
      isDestroyed: () => false,
      send,
    });

    expect(get).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("credentials:fill", credentials);
  });

  it.each([
    "http://account.aliyun.com/login",
    "https://account.aliyun.com.example.com/login",
    "https://idp.example.com/login",
    SAVED_URL,
  ])("does not decrypt or send credentials to %s", async (url) => {
    const get = vi.fn(async () => ({ username: "ram-user", password: "secret" }));
    const consoleViews = new ConsoleViews({
      window: {} as never,
      workspace: {} as Workspace,
      session: {} as ConsoleSession,
      credentialStore: { get } as never,
      autofillPreload: "/login-autofill.js",
      externalOpener: { open: vi.fn(async () => undefined) },
      onShortcut: vi.fn(),
    });
    const send = vi.fn();
    const fill = Reflect.get(consoleViews, "fillLoginCredentials") as (
      webContents: unknown,
    ) => Promise<void>;

    await fill.call(consoleViews, {
      getURL: () => url,
      isDestroyed: () => false,
      send,
    });

    expect(get).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("ConsoleViews Flow navigation", () => {
  it("allows Flow in the current view and records it as a regionless Codeup page", () => {
    const harness = createNavigationHarness();
    const event = { preventDefault: vi.fn() };

    harness.webContents.emit("will-navigate", event, FLOW_URL);
    expect(event.preventDefault).not.toHaveBeenCalled();

    harness.setCurrentUrl(FLOW_URL);
    harness.webContents.emit("did-navigate");
    expect(harness.dispatch).toHaveBeenCalledWith({
      type: "update-tab",
      tabId: "tab-1",
      url: FLOW_URL,
      target: { product: "codeup", regionId: null },
      canGoBack: true,
      canGoForward: false,
    });
  });

  it("captures a Flow popup as a regionless Codeup tab", () => {
    const harness = createNavigationHarness();

    expect(harness.openPopup(FLOW_URL)).toEqual({ action: "deny" });
    expect(harness.dispatch).toHaveBeenCalledWith({
      type: "open-url",
      product: "codeup",
      regionId: null,
      url: FLOW_URL,
      sourceTabId: "tab-1",
    });
  });
});

describe("ConsoleViews unrestricted HTTPS navigation", () => {
  const EXTERNAL_URL = "https://idp.example.com/sso/continue";

  it.each(["will-navigate", "will-redirect"])(
    "allows an HTTPS %s event without checking its domain",
    (eventName) => {
      const harness = createNavigationHarness();
      const event = { preventDefault: vi.fn() };

      harness.webContents.emit(eventName, event, EXTERNAL_URL);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "set-notice" }),
      );
    },
  );

  it("records the external hostname without replacing the stable console target", () => {
    const harness = createNavigationHarness();

    harness.setCurrentUrl(EXTERNAL_URL);
    harness.webContents.emit("did-navigate");

    expect(harness.dispatch).toHaveBeenCalledWith({
      type: "update-tab",
      tabId: "tab-1",
      url: EXTERNAL_URL,
      target: undefined,
      canGoBack: true,
      canGoForward: false,
    });
  });

  it("does not persist a temporary external page title", () => {
    const harness = createNavigationHarness();
    const event = { preventDefault: vi.fn() };

    harness.setCurrentUrl(EXTERNAL_URL);
    harness.webContents.emit("page-title-updated", event, "Enterprise SSO callback");

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(harness.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "update-tab", title: "Enterprise SSO callback" }),
    );
  });

  it("loads an HTTPS popup in the current view without opening a native window", () => {
    const harness = createNavigationHarness();

    expect(harness.openPopup(EXTERNAL_URL)).toEqual({ action: "deny" });
    expect(harness.webContents.loadURL).toHaveBeenCalledWith(EXTERNAL_URL);
    expect(harness.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "set-notice" }),
    );
  });

  it("preserves POST data, content type, and referrer for an HTTPS form popup", () => {
    const harness = createNavigationHarness();
    const postData = [{ type: "rawData" as const, bytes: Buffer.from("SAMLResponse=value") }];
    const referrer = { url: "https://codeup.aliyun.com/", policy: "strict-origin" as const };

    expect(harness.openPopup(EXTERNAL_URL, {
      postBody: {
        boundary: "opsdock-boundary",
        contentType: "multipart/form-data",
        data: postData,
      },
      referrer,
    })).toEqual({ action: "deny" });
    expect(harness.webContents.loadURL).toHaveBeenCalledWith(EXTERNAL_URL, {
      extraHeaders: "Content-Type: multipart/form-data; boundary=opsdock-boundary",
      httpReferrer: referrer,
      postData,
    });
  });

  it("reports a popup load failure without creating an unhandled rejection", async () => {
    const harness = createNavigationHarness();
    harness.webContents.loadURL.mockRejectedValueOnce(new Error("load failed"));

    expect(harness.openPopup(EXTERNAL_URL)).toEqual({ action: "deny" });

    await vi.waitFor(() => expect(harness.dispatch).toHaveBeenCalledWith({
      type: "set-notice",
      notice: "控制台页面加载失败，请检查网络后重试",
    }));
  });

  it.each(["javascript:alert(1)", "data:text/html,hello", "file:///tmp/secret"])(
    "still blocks an unsafe popup protocol: %s",
    (url) => {
      const harness = createNavigationHarness();

      expect(harness.openPopup(url)).toEqual({ action: "deny" });
      expect(harness.webContents.loadURL).not.toHaveBeenCalled();
      expect(harness.dispatch).toHaveBeenCalledWith({
        type: "set-notice",
        notice: "只允许 HTTPS 页面链接",
      });
    },
  );

  it.each(["will-navigate", "will-redirect"])(
    "blocks an unsafe %s event before it reaches the current view",
    (eventName) => {
      const harness = createNavigationHarness();
      const event = { preventDefault: vi.fn() };

      harness.webContents.emit(eventName, event, "javascript:alert(1)");

      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(harness.webContents.loadURL).not.toHaveBeenCalled();
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.dispatch).toHaveBeenCalledWith({
        type: "set-notice",
        notice: "只允许 HTTPS 页面链接",
      });
    },
  );

  it("keeps documentation in the current view for current and popup navigation", () => {
    const helpUrl = "https://help.aliyun.com/document_detail/123.html";
    const current = createNavigationHarness();
    const event = { preventDefault: vi.fn() };

    current.webContents.emit("will-navigate", event, helpUrl);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(current.open).not.toHaveBeenCalled();

    const popup = createNavigationHarness();
    expect(popup.openPopup(helpUrl)).toEqual({ action: "deny" });
    expect(popup.open).not.toHaveBeenCalled();
    expect(popup.webContents.loadURL).toHaveBeenCalledWith(helpUrl);
  });

  it("reports a failed HTTP-to-HTTPS navigation upgrade", async () => {
    const harness = createNavigationHarness();
    const event = { preventDefault: vi.fn() };
    harness.webContents.loadURL.mockRejectedValueOnce(new Error("TLS failed"));

    harness.webContents.emit("will-redirect", event, "http://account.aliyun.com/login");

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(harness.webContents.loadURL).toHaveBeenCalledWith("https://account.aliyun.com/login");
    await vi.waitFor(() => expect(harness.dispatch).toHaveBeenCalledWith({
      type: "set-notice",
      notice: "控制台页面加载失败，请检查网络后重试",
    }));
  });
});

describe("ConsoleViews adaptive recycling", () => {
  beforeEach(() => electronMocks.getAppMetrics.mockClear());
  function createRecycleHarness(
    viewCount: number,
    workingSetBytes: number,
    pinnedIds: readonly string[] = [],
  ) {
    electronMocks.workingSetSizeKb = workingSetBytes / 1024;
    const tabs = Array.from({ length: viewCount }, (_, index) => ({
      ...createTab(),
      id: `tab-${index + 1}`,
      pinned: pinnedIds.includes(`tab-${index + 1}`),
    }));
    const dispatch = vi.fn(async (_command?: Parameters<Workspace["dispatch"]>[0]) => ({ ok: true as const, snapshot: {} as WorkspaceSnapshot }));
    const workspace = {
      getSnapshot: () => ({ tabs }) as WorkspaceSnapshot,
      dispatch,
    } as unknown as Workspace;
    const window = {
      contentView: {
        children: [],
        addChildView: vi.fn(),
        removeChildView: vi.fn(),
      },
      isDestroyed: () => false,
    };
    const consoleViews = new ConsoleViews({
      window: window as never,
      workspace,
      session: {} as ConsoleSession,
      autofillPreload: "/login-autofill.js",
      externalOpener: { open: vi.fn(async () => undefined) },
      onShortcut: vi.fn(),
    });
    const views = new Map(tabs.map((tab, index) => [
      tab.id,
      {
        view: {
          setVisible: vi.fn(),
          setBounds: vi.fn(),
          webContents: { isDestroyed: () => false, loadURL: vi.fn(async (): Promise<void> => undefined), stop: vi.fn() },
        },
        tabId: tab.id,
        lastVisibleAt: index + 1,
      },
    ]));
    const close = vi.fn(async (tabId: string) => {
      views.delete(tabId);
      return true;
    });
    Reflect.set(consoleViews, "views", views);
    Reflect.set(consoleViews, "activeTabId", tabs.at(-1)?.id ?? null);
    Reflect.set(consoleViews, "close", close);
    const recycle = Reflect.get(consoleViews, "recycleInactiveViews") as () => Promise<void>;
    return { close, consoleViews, dispatch, recycle, tabs, views, window };
  }

  it.each([
    [900 * 1024 ** 2, 9, 1],
    [1.2 * 1024 ** 3, 8, 2],
    [1.6 * 1024 ** 3, 6, 2],
  ])("adapts the live view limit at %d bytes", async (workingSet, viewCount, recycled) => {
    const harness = createRecycleHarness(viewCount, workingSet);

    await harness.recycle.call(harness.consoleViews);

    expect(harness.close).toHaveBeenCalledTimes(recycled);
  });

  it("recycles unpinned tabs first and pinned tabs only when required", async () => {
    const harness = createRecycleHarness(
      6,
      1.6 * 1024 ** 3,
      ["tab-1", "tab-2", "tab-3", "tab-4"],
    );

    await harness.recycle.call(harness.consoleViews);

    expect(harness.close.mock.calls.map(([tabId]) => tabId)).toEqual(["tab-5", "tab-1"]);
  });

  it("skips process metrics while four or fewer views are alive", async () => {
    const harness = createRecycleHarness(4, 1.6 * 1024 ** 3);

    await harness.recycle.call(harness.consoleViews);

    expect(electronMocks.getAppMetrics).not.toHaveBeenCalled();
    expect(harness.close).not.toHaveBeenCalled();
    await harness.consoleViews.destroyAll();
  });

  it("coalesces a burst of recycle requests before execution", async () => {
    const harness = createRecycleHarness(9, 900 * 1024 ** 2);
    const queueRecycle = Reflect.get(harness.consoleViews, "queueRecycle") as () => void;

    for (let index = 0; index < 20; index += 1) queueRecycle.call(harness.consoleViews);
    await Reflect.get(harness.consoleViews, "recycleQueue");

    expect(electronMocks.getAppMetrics).toHaveBeenCalledOnce();
    expect(harness.views.size).toBe(8);
    await harness.consoleViews.destroyAll();
  });

  it.each([false, true])("coalesces requests during recycling and respects shutdown=%s", async (shutdown) => {
    const harness = createRecycleHarness(9, 900 * 1024 ** 2);
    let releaseRecycle!: () => void;
    const recycleGate = new Promise<void>((resolve) => { releaseRecycle = resolve; });
    const recycle = vi.spyOn(
      harness.consoleViews as unknown as { recycleInactiveViews(): Promise<void> },
      "recycleInactiveViews",
    ).mockImplementationOnce(async () => {
      await recycleGate;
      await harness.recycle.call(harness.consoleViews);
    });
    const queueRecycle = Reflect.get(harness.consoleViews, "queueRecycle") as () => void;
    queueRecycle.call(harness.consoleViews);
    await vi.waitFor(() => expect(recycle).toHaveBeenCalledOnce());
    for (let index = 0; index < 20; index += 1) queueRecycle.call(harness.consoleViews);
    const destroying = shutdown ? harness.consoleViews.destroyAll() : null;

    releaseRecycle();
    await Reflect.get(harness.consoleViews, "recycleQueue");

    expect(recycle).toHaveBeenCalledTimes(shutdown ? 1 : 2);
    await (destroying ?? harness.consoleViews.destroyAll());
  });

  it("skips beforeunload-protected tabs without reporting recycle failure", async () => {
    const harness = createRecycleHarness(6, 1.6 * 1024 ** 3);
    harness.close.mockImplementation(async () => false);

    await expect(harness.recycle.call(harness.consoleViews)).resolves.toBeUndefined();
    expect(harness.close).toHaveBeenCalledTimes(5);
    expect(harness.close.mock.calls.every((args) => args.length === 1)).toBe(true);
    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.views).toHaveLength(6);
    expect(harness.consoleViews.performanceDiagnostics().recycledViewCount).toBe(0);
  });

  it("keeps sequential retries within the view budget plus the page being loaded", async () => {
    const harness = createRecycleHarness(20, 1.6 * 1024 ** 3);
    harness.tabs.forEach((tab) => { tab.loadState = "error"; });
    const available = new Map(harness.views);
    harness.views.clear();
    let peak = 0;
    const create = vi.fn((tab: WorkspaceTab) => {
      peak = Math.max(peak, harness.views.size + 1);
      return available.get(tab.id)!;
    });
    Reflect.set(harness.consoleViews, "create", create);

    await expect(harness.consoleViews.retryFailedTabs()).resolves.toEqual({ attempted: 20, succeeded: 20, failed: 0 });

    expect(peak).toBe(5);
    expect(harness.views.size).toBe(4);
    expect(harness.views.has("tab-20")).toBe(true);
    expect(harness.close.mock.calls.every((args) => args.length === 1)).toBe(true);
    expect(harness.consoleViews.performanceDiagnostics()).toEqual({
      peakLiveViewCount: 5,
      recycledViewCount: 16,
      reloadedAfterRecycleCount: 0,
    });
    await harness.consoleViews.activate(harness.tabs[0]);
    await Reflect.get(harness.consoleViews, "recycleQueue");
    await harness.consoleViews.activate(harness.tabs[0]);
    expect(harness.consoleViews.performanceDiagnostics()).toEqual({
      peakLiveViewCount: 5,
      recycledViewCount: 17,
      reloadedAfterRecycleCount: 1,
    });
    await harness.consoleViews.destroyAll();
  });

  it("still retries failed tabs deferred by recycling an earlier page", async () => {
    const harness = createRecycleHarness(6, 1.6 * 1024 ** 3);
    harness.tabs.forEach((tab) => { tab.loadState = "error"; });
    const available = new Map(harness.views);
    Reflect.set(harness.consoleViews, "create", (tab: WorkspaceTab) => available.get(tab.id));
    harness.dispatch.mockImplementation(async (command) => {
      if (command?.type === "update-tab" && command.loadState) {
        harness.tabs.find((tab) => tab.id === command.tabId)!.loadState = command.loadState;
      }
      return { ok: true, snapshot: {} as WorkspaceSnapshot };
    });

    await expect(harness.consoleViews.retryFailedTabs()).resolves.toEqual({ attempted: 6, succeeded: 6, failed: 0 });

    for (const managed of available.values()) expect(managed.view.webContents.loadURL).toHaveBeenCalledOnce();
    await harness.consoleViews.destroyAll();
  });

  it("protects the loading retry from timer recycling without blocking activation", async () => {
    const harness = createRecycleHarness(6, 1.6 * 1024 ** 3);
    harness.tabs[0].loadState = "error";
    const loading = harness.views.get("tab-1")!;
    let finishLoad!: () => void;
    loading.view.webContents.loadURL.mockImplementation(() => new Promise<void>((resolve) => { finishLoad = resolve; }));
    const retry = harness.consoleViews.retryFailedTabs();
    await vi.waitFor(() => expect(loading.view.webContents.loadURL).toHaveBeenCalledOnce());

    const queueRecycle = Reflect.get(harness.consoleViews, "queueRecycle") as () => void;
    queueRecycle.call(harness.consoleViews);
    await Reflect.get(harness.consoleViews, "recycleQueue");
    expect(harness.close).not.toHaveBeenCalledWith("tab-1");
    expect(harness.close).not.toHaveBeenCalledWith("tab-6");
    await harness.consoleViews.activate(harness.tabs[0]);

    finishLoad();
    await retry;
    await harness.consoleViews.destroyAll();
  });

  it("resizes only the visible active view and catches up background views on activation", async () => {
    const harness = createRecycleHarness(3, 0);
    const background = harness.views.get("tab-1")!.view;
    const active = harness.views.get("tab-3")!.view;
    const firstBounds = { x: 0, y: 100, width: 800, height: 600 };
    const latestBounds = { ...firstBounds, width: 1000 };

    harness.consoleViews.setBounds(firstBounds, true);
    harness.consoleViews.setBounds(latestBounds, false);
    expect(background.setBounds).not.toHaveBeenCalled();
    expect(background.setVisible).not.toHaveBeenCalled();
    expect(active.setBounds).toHaveBeenCalledExactlyOnceWith(firstBounds);
    expect(active.setVisible).toHaveBeenLastCalledWith(false);

    await harness.consoleViews.activate(harness.tabs[0]);
    expect(background.setBounds).toHaveBeenCalledExactlyOnceWith(latestBounds);
    expect(background.setVisible).toHaveBeenLastCalledWith(false);
    harness.consoleViews.setBounds(latestBounds, true);
    expect(background.setVisible).toHaveBeenLastCalledWith(true);
    expect(active.setBounds).toHaveBeenCalledTimes(1);
    await harness.consoleViews.destroyAll();
  });

  it("recycles periodically and stops the timer during destroy", async () => {
    vi.useFakeTimers();
    try {
      const harness = createRecycleHarness(1, 0);
      const recycle = vi.spyOn(
        harness.consoleViews as unknown as { recycleInactiveViews(): Promise<void> },
        "recycleInactiveViews",
      ).mockResolvedValue(undefined);

      await vi.advanceTimersByTimeAsync(45_000);
      expect(recycle).toHaveBeenCalledOnce();

      await harness.consoleViews.destroyAll();
      await vi.advanceTimersByTimeAsync(45_000);
      expect(recycle).toHaveBeenCalledOnce();

      const restart = Reflect.get(harness.consoleViews, "startRecycleTimer") as () => void;
      restart.call(harness.consoleViews);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(recycle).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for an in-flight recycle before activating the same tab", async () => {
    const harness = createRecycleHarness(6, 1.6 * 1024 ** 3);
    harness.tabs[5].loadState = "error";
    let finishRetryLoad!: () => void;
    harness.views.get("tab-6")!.view.webContents.loadURL.mockImplementation(
      () => new Promise<void>((resolve) => { finishRetryLoad = resolve; }),
    );
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    harness.close.mockImplementation(async (tabId: string) => {
      await closeGate;
      harness.views.delete(tabId);
      return true;
    });
    const createdView = {
      setVisible: vi.fn(),
      setBounds: vi.fn(),
      webContents: {
        isDestroyed: () => false,
        loadURL: vi.fn(async () => undefined),
      },
    };
    const create = vi.fn((tab: WorkspaceTab) => ({
      view: createdView,
      tabId: tab.id,
      lastVisibleAt: Date.now(),
    }));
    Reflect.set(harness.consoleViews, "create", create);
    Reflect.set(harness.consoleViews, "contentVisible", true);

    const queueRecycle = Reflect.get(harness.consoleViews, "queueRecycle") as () => void;
    queueRecycle.call(harness.consoleViews);
    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledWith("tab-1"));
    const retry = harness.consoleViews.retryFailedTabs();

    let activated = false;
    const activation = harness.consoleViews.activate(harness.tabs[0]).then(() => {
      activated = true;
    });
    await Promise.resolve();
    expect(activated).toBe(false);

    releaseClose?.();
    await activation;
    expect(create).toHaveBeenCalledWith(harness.tabs[0]);
    expect(createdView.setVisible).toHaveBeenLastCalledWith(true);
    await vi.waitFor(() => expect(finishRetryLoad).toBeTypeOf("function"));
    finishRetryLoad();
    await retry;
    await harness.consoleViews.destroyAll();
  });
});

describe("ConsoleViews runtime recovery", () => {
  it("skips duplicate normalized bounds updates", () => {
    const { consoleViews } = createHarness(CURRENT_URL);
    const view = Reflect.get(consoleViews, "views").get("tab-1").view as {
      setBounds?: ReturnType<typeof vi.fn>;
      setVisible?: ReturnType<typeof vi.fn>;
    };
    view.setBounds = vi.fn();
    view.setVisible = vi.fn();

    consoleViews.setBounds({ x: 1.2, y: 2.4, width: 300.1, height: 400.2 }, true);
    consoleViews.setBounds({ x: 1.4, y: 2.2, width: 300.4, height: 400.4 }, true);

    expect(view.setBounds).toHaveBeenCalledOnce();
    expect(view.setVisible).toHaveBeenCalledOnce();
  });

  it("retries failed tabs sequentially and shares concurrent requests", async () => {
    const tabs = [
      { ...createTab(), id: "error", loadState: "error" as const },
      { ...createTab(), id: "crashed", loadState: "crashed" as const },
      { ...createTab(), id: "ready", loadState: "ready" as const },
    ];
    const dispatch = vi.fn(async () => ({ ok: true as const, snapshot: {} as WorkspaceSnapshot }));
    const workspace = {
      getSnapshot: () => ({ tabs }) as WorkspaceSnapshot,
      dispatch,
    } as unknown as Workspace;
    const consoleViews = new ConsoleViews({
      window: {} as never,
      workspace,
      session: {} as ConsoleSession,
      autofillPreload: "/login-autofill.js",
      externalOpener: { open: vi.fn(async () => undefined) },
      onShortcut: vi.fn(),
    });
    let activeLoads = 0;
    let maxActiveLoads = 0;
    const loadURL = vi.fn(async () => {
      activeLoads += 1;
      maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
      await Promise.resolve();
      activeLoads -= 1;
    });
    Reflect.set(consoleViews, "views", new Map(tabs.map((tab) => [
      tab.id,
      { view: { webContents: { isDestroyed: () => false, loadURL } }, tabId: tab.id, lastVisibleAt: 1 },
    ])));

    const first = consoleViews.retryFailedTabs();
    const second = consoleViews.retryFailedTabs();

    expect(first).toBe(second);
    await expect(first).resolves.toEqual({ attempted: 2, succeeded: 2, failed: 0 });
    expect(loadURL).toHaveBeenCalledTimes(2);
    expect(maxActiveLoads).toBe(1);
    expect(dispatch).toHaveBeenCalledWith({ type: "set-notice", notice: "已重试 2 个标签" });
    Reflect.set(consoleViews, "views", new Map());
    await consoleViews.destroyAll();
  });

  it("reports retry failures without stopping later tabs", async () => {
    const tabs = [
      { ...createTab(), id: "error", loadState: "error" as const },
      { ...createTab(), id: "crashed", loadState: "crashed" as const },
    ];
    const dispatch = vi.fn(async () => ({ ok: true as const, snapshot: {} as WorkspaceSnapshot }));
    const consoleViews = new ConsoleViews({
      window: {} as never,
      workspace: {
        getSnapshot: () => ({ tabs }) as WorkspaceSnapshot,
        dispatch,
      } as unknown as Workspace,
      session: {} as ConsoleSession,
      autofillPreload: "/login-autofill.js",
      externalOpener: { open: vi.fn(async () => undefined) },
      onShortcut: vi.fn(),
    });
    const loadURL = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(undefined);
    Reflect.set(consoleViews, "views", new Map(tabs.map((tab) => [
      tab.id,
      { view: { webContents: { isDestroyed: () => false, loadURL } }, tabId: tab.id, lastVisibleAt: 1 },
    ])));

    await expect(consoleViews.retryFailedTabs()).resolves.toEqual({
      attempted: 2,
      succeeded: 1,
      failed: 1,
    });
    expect(loadURL).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith({
      type: "set-notice",
      notice: "已重试 2 个标签，1 个仍加载失败",
    });
    Reflect.set(consoleViews, "views", new Map());
    await consoleViews.destroyAll();
  });

  it("bounds automatic reloads for an unresponsive page", async () => {
    const harness = createNavigationHarness();

    harness.webContents.emit("unresponsive");
    harness.webContents.emit("unresponsive");
    harness.webContents.emit("responsive");
    harness.webContents.emit("unresponsive");
    harness.webContents.emit("responsive");
    harness.webContents.emit("unresponsive");

    expect(harness.webContents.reload).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(harness.dispatch).toHaveBeenCalledWith({
      type: "update-tab",
      tabId: "tab-1",
      loadState: "error",
      errorMessage: "控制台页面持续无响应，请手动刷新或关闭标签",
    }));
  });

  it("restores the automatic recovery budget after a stable load", async () => {
    vi.useFakeTimers();
    try {
      const harness = createNavigationHarness();

      harness.webContents.emit("unresponsive");
      harness.webContents.emit("responsive");
      harness.webContents.emit("did-stop-loading");
      await vi.advanceTimersByTimeAsync(30_000);
      harness.webContents.emit("unresponsive");

      expect(harness.webContents.reload).toHaveBeenCalledTimes(2);
      expect(harness.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({
        loadState: "error",
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});
