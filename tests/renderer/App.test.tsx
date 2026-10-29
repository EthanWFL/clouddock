import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/src/App";
import { useRendererStore } from "../../src/renderer/src/store";
import type { OpsDockApi } from "../../src/shared/api";
import type { NativeMenuAction } from "../../src/shared/ipc";
import type { ConsoleShortcut } from "../../src/shared/console-shortcut";
import {
  createDefaultSnapshot,
  type Favorite,
  type WorkspaceSnapshot,
  type WorkspaceTab,
} from "../../src/shared/model";

function createTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "ack-tab",
    product: "ack",
    regionId: "cn-beijing",
    url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
    title: "集群列表",
    createdAt: 100,
    lastActiveAt: 200,
    pinned: false,
    taskStatus: null,
    loadState: "ready",
    canGoBack: false,
    canGoForward: true,
    ...overrides,
  };
}

function createFavorite(overrides: Partial<Favorite> = {}): Favorite {
  return {
    id: "favorite-1",
    name: "生产集群",
    product: "ack",
    regionId: "cn-beijing",
    url: "https://cs.console.aliyun.com/#/k8s/cluster/detail/production?region=cn-beijing",
    createdAt: 300,
    ...overrides,
  };
}

function populatedSnapshot(
  overrides: Partial<WorkspaceSnapshot> = {},
): WorkspaceSnapshot {
  const ackTab = createTab();
  const kafkaTab = createTab({
    id: "kafka-tab",
    product: "kafka",
    regionId: "cn-shanghai",
    url: "https://kafka.console.aliyun.com/region/cn-shanghai/consumer-groups",
    title: "消费者组",
    createdAt: 110,
    lastActiveAt: 190,
  });

  return {
    ...createDefaultSnapshot(),
    onboardingComplete: true,
    productRegionIds: {
      ack: ["cn-beijing", "cn-shanghai"],
      kafka: ["cn-beijing", "cn-shanghai"],
      mse: ["cn-beijing", "cn-shanghai"],
    },
    tabs: [ackTab, kafkaTab],
    activeTabId: ackTab.id,
    favorites: [createFavorite()],
    ...overrides,
  };
}

interface ApiHarness {
  api: OpsDockApi;
  dispatch: ReturnType<typeof vi.fn<OpsDockApi["dispatch"]>>;
  logout: ReturnType<typeof vi.fn<OpsDockApi["logout"]>>;
  setViewBounds: ReturnType<typeof vi.fn<OpsDockApi["setViewBounds"]>>;
  emitWorkspace(snapshot: WorkspaceSnapshot): void;
  emitConsoleShortcut(shortcut: ConsoleShortcut): void;
}

function installApi(snapshot: WorkspaceSnapshot): ApiHarness {
  const dispatch = vi.fn<OpsDockApi["dispatch"]>(async () => ({
    ok: true,
    snapshot,
  }));
  const logout = vi.fn<OpsDockApi["logout"]>(async () => ({
    ok: true,
    snapshot: {
      ...snapshot,
      tabs: [],
      activeTabId: null,
    },
  }));
  const setViewBounds = vi.fn<OpsDockApi["setViewBounds"]>();
  let workspaceListener: ((nextSnapshot: WorkspaceSnapshot) => void) | null = null;
  let consoleShortcutListener: ((shortcut: ConsoleShortcut) => void) | null = null;
  const api: OpsDockApi = {
    getAppearance: vi.fn<OpsDockApi["getAppearance"]>(async () => ({
      colorScheme: "light",
      accentColor: "#0a84ff",
    })),
    subscribeAppearance: vi.fn<OpsDockApi["subscribeAppearance"]>(() => () => undefined),
    getWorkspace: vi.fn(async () => snapshot),
    dispatch,
    subscribeWorkspace: vi.fn((listener) => {
      workspaceListener = listener;
      return () => {
        if (workspaceListener === listener) workspaceListener = null;
      };
    }),
    subscribeConsoleShortcut: vi.fn((listener) => {
      consoleShortcutListener = listener;
      return () => {
        if (consoleShortcutListener === listener) consoleShortcutListener = null;
      };
    }),
    setViewBounds,
    performViewAction: vi.fn(async () => null),
    copyDiagnostics: vi.fn(async () => undefined),
    copyWorkspaceContext: vi.fn(async () => undefined),
    retryFailedTabs: vi.fn(async () => ({ attempted: 0, succeeded: 0, failed: 0 })),
    logout,
    getLoginCredentials: vi.fn(async () => ({ configured: false, username: null })),
    saveLoginCredentials: vi.fn(async () => ({ configured: true, username: "user@example.com" })),
    clearLoginCredentials: vi.fn(async () => ({ configured: false, username: null })),
    getClipboardConsoleUrls: vi.fn(async () => []),
    getVersion: vi.fn(async () => "1.0.0"),
    showNativeMenu: vi.fn(async () => null),
  };

  Object.defineProperty(window, "opsdock", {
    configurable: true,
    value: api,
  });

  return {
    api,
    dispatch,
    logout,
    setViewBounds,
    emitWorkspace(nextSnapshot) {
      workspaceListener?.(nextSnapshot);
    },
    emitConsoleShortcut(shortcut) {
      consoleShortcutListener?.(shortcut);
    },
  };
}

async function selectNativeMenu(action: NativeMenuAction, button = "更多操作") {
  vi.mocked(window.opsdock.showNativeMenu).mockResolvedValueOnce(action);
  await userEvent.click(await screen.findByRole("button", { name: button }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("workspace startup", () => {
  it("shows a retryable error when the initial workspace request fails", async () => {
    const user = userEvent.setup();
    const snapshot = populatedSnapshot();
    const { api } = installApi(snapshot);
    const getWorkspace = vi.mocked(api.getWorkspace);
    getWorkspace.mockRejectedValueOnce(new Error("IPC unavailable"));
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("工作区恢复失败，请重试");
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("CloudDock", { selector: "strong" })).toBeVisible();
    expect(getWorkspace).toHaveBeenCalledTimes(2);
  });

  it("does not let a late initial response overwrite a newer subscription snapshot", async () => {
    const stale = populatedSnapshot();
    const newer = populatedSnapshot({
      tabs: [createTab({ title: "订阅中的新状态" })],
      activeTabId: "ack-tab",
    });
    const { api } = installApi(stale);
    let resolveInitial: ((snapshot: WorkspaceSnapshot) => void) | undefined;
    let emitSnapshot: ((snapshot: WorkspaceSnapshot) => void) | undefined;
    api.getWorkspace = vi.fn(() => new Promise<WorkspaceSnapshot>((resolve) => {
      resolveInitial = resolve;
    }));
    api.subscribeWorkspace = vi.fn((listener) => {
      emitSnapshot = listener;
      return () => undefined;
    });
    render(<App />);

    act(() => emitSnapshot?.(newer));
    expect(await screen.findByRole("tab", { name: "订阅中的新状态 · 北京" })).toBeVisible();
    await act(async () => resolveInitial?.(stale));

    expect(screen.getByRole("tab", { name: "订阅中的新状态 · 北京" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "集群列表 · 北京" })).not.toBeInTheDocument();
  });
});

describe("onboarding", () => {
  it("switches the active module region settings and hides them for global modules", async () => {
    const user = userEvent.setup();
    installApi(createDefaultSnapshot());
    render(<App />);

    const ackCard = await screen.findByRole("button", { name: /^ACK1 个地域$/ });
    const kafkaCard = screen.getByRole("button", { name: /^Kafka1 个地域$/ });
    const dmsCard = screen.getByRole("button", { name: "DMS全局服务" });
    expect(ackCard).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "ACK 地域配置" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "ACK · 华北 2（北京）" })).toBeDisabled();

    await user.click(kafkaCard);
    expect(ackCard).toHaveAttribute("aria-pressed", "false");
    expect(kafkaCard).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "Kafka 地域配置" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "ACK 地域配置" })).not.toBeInTheDocument();

    await user.click(dmsCard);
    expect(dmsCard).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("地域配置")).not.toBeInTheDocument();
  });

  it("submits the selected modules, regions, and initial product", async () => {
    const user = userEvent.setup();
    const snapshot = createDefaultSnapshot();
    const { dispatch } = installApi(snapshot);
    render(<App />);

    await screen.findByRole("heading", { name: "CloudDock" });
    for (const product of ["ACK", "Kafka", "MSE", "DMS", "Codeup", "SLS"]) {
      expect(screen.getByRole("checkbox", { name: `${product} 模块` })).toBeChecked();
    }
    expect(screen.getByRole("button", { name: /^ACK1 个地域$/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("checkbox", { name: "ACK · 华北 2（北京）" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "ACK" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Kafka" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "MSE" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "DMS" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Codeup" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "SLS" })).toHaveAttribute("aria-pressed", "false");

    await user.click(screen.getByRole("checkbox", { name: "ACK · 华东 2（上海）" }));
    await user.click(screen.getByRole("checkbox", { name: "ACK · 华北 2（北京）" }));
    await user.click(screen.getByRole("button", { name: /^Kafka1 个地域$/ }));
    expect(screen.getByRole("checkbox", { name: "Kafka · 华北 2（北京）" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: /^MSE1 个地域$/ }));
    expect(screen.getAllByRole("checkbox", { name: /^MSE · / })).toHaveLength(2);
    await user.click(screen.getByRole("checkbox", { name: "MSE · 华东 2（上海）" }));
    await user.click(screen.getByRole("checkbox", { name: "MSE · 华北 2（北京）" }));

    for (const product of ["ACK", "Kafka", "DMS", "Codeup", "SLS"]) {
      await user.click(screen.getByRole("checkbox", { name: `${product} 模块` }));
    }
    expect(screen.queryByRole("button", { name: "ACK" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MSE" })).toHaveAttribute("aria-pressed", "true");
    const mseCheckbox = screen.getByRole("checkbox", { name: "MSE 模块" });
    await user.click(mseCheckbox);
    expect(screen.getByRole("button", { name: "开始使用" })).toBeDisabled();
    await user.click(mseCheckbox);
    expect(screen.getByRole("button", { name: "MSE" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "开始使用" }));

    expect(dispatch).toHaveBeenCalledWith({
      type: "complete-onboarding",
      selectedProducts: ["mse"],
      productRegionIds: {
        ack: ["cn-shanghai"],
        kafka: ["cn-beijing"],
        mse: ["cn-shanghai"],
      },
      initialProduct: "mse",
    });
  });

  it("uses a restored selected module as the initial product", async () => {
    const user = userEvent.setup();
    const snapshot = {
      ...createDefaultSnapshot(),
      selectedProducts: ["sls" as const],
    };
    const { dispatch } = installApi(snapshot);
    render(<App />);

    expect(await screen.findByRole("button", { name: "SLS" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "开始使用" }));

    expect(dispatch).toHaveBeenCalledWith({
      type: "complete-onboarding",
      selectedProducts: ["sls"],
      productRegionIds: snapshot.productRegionIds,
      initialProduct: "sls",
    });
  });

  it("recovers from an onboarding IPC failure and allows retrying", async () => {
    const user = userEvent.setup();
    const { dispatch } = installApi(createDefaultSnapshot());
    dispatch.mockRejectedValueOnce(new Error("IPC unavailable"));
    render(<App />);

    const submit = await screen.findByRole("button", { name: "开始使用" });
    await user.click(submit);

    expect(await screen.findByRole("alert")).toHaveTextContent("初始化失败，请重试");
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("shows and dismisses a workspace recovery notice during onboarding", async () => {
    const user = userEvent.setup();
    const snapshot = { ...createDefaultSnapshot(), notice: "工作区数据已备份并恢复默认设置" };
    const { dispatch } = installApi(snapshot);
    render(<App />);

    expect(await screen.findByRole("status")).toHaveTextContent(snapshot.notice);
    await user.click(screen.getByRole("button", { name: "关闭提示" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "set-notice", notice: null });
  });
});

describe("populated workspace shell", () => {
  it("shows fixed product-region entries, restored tabs, and local favorites", async () => {
    const snapshot = populatedSnapshot();
    installApi(snapshot);
    render(<App />);

    await screen.findByText("CloudDock", { selector: "strong" });
    expect(screen.getByRole("heading", { name: "ACK" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Kafka" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "MSE" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "DMS" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Codeup" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "SLS" })).toBeVisible();
    const ackTab = screen.getByRole("tab", { name: "集群列表 · 北京" });
    const kafkaTab = screen.getByRole("tab", { name: "消费者组 · 上海" });
    expect(screen.getByRole("tablist", { name: "打开的控制台标签" })).toBeVisible();
    expect(ackTab).toHaveClass("active");
    expect(ackTab).toHaveAttribute("aria-selected", "true");
    expect(ackTab).toHaveAttribute("tabindex", "0");
    expect(kafkaTab).toHaveAttribute("aria-selected", "false");
    expect(kafkaTab).toHaveAttribute("tabindex", "-1");
    const tabPanel = screen.getByRole("tabpanel", { name: "集群列表 · 北京" });
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab).toHaveAttribute("aria-controls", tabPanel.id);
      expect(document.getElementById(tab.getAttribute("aria-controls")!)).toBe(tabPanel);
    }
    expect(tabPanel).toHaveAttribute("aria-labelledby", ackTab.id);
    expect(screen.getByRole("toolbar", { name: "控制台操作" })).toBeVisible();
    expect(screen.getByRole("group", { name: "导航" })).toBeVisible();
    expect(screen.getByRole("group", { name: "页面操作" })).toBeVisible();
    expect(ackTab.parentElement).toHaveAttribute("data-product", "ack");
    expect(ackTab.parentElement).toHaveAttribute("data-state", "active");
    expect(kafkaTab).toBeVisible();
    expect(kafkaTab.parentElement).toHaveAttribute("data-product", "kafka");
    expect(kafkaTab.parentElement).toHaveAttribute("data-state", "inactive");
    expect(screen.getByTitle("ACK · 北京")).toHaveClass("selected");
    expect(screen.getByTitle("ACK · 北京")).toHaveAttribute("data-product", "ack");
    expect(screen.getByTitle("ACK · 北京")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTitle("ACK · 上海")).toBeVisible();
    expect(screen.getByTitle("ACK · 上海")).not.toHaveAttribute("aria-current");
    expect(screen.getByTitle("Kafka · 北京")).toBeVisible();
    expect(screen.getByTitle("Kafka · 上海")).toHaveAttribute("data-product", "kafka");
    expect(screen.getByTitle("MSE · 北京")).toHaveAttribute("data-product", "mse");
    expect(screen.getByTitle("MSE · 上海")).toBeVisible();
    expect(screen.getByRole("button", { name: "DMS" })).toHaveAttribute("data-product", "dms");
    expect(screen.getByRole("button", { name: "Codeup" })).toHaveAttribute("data-product", "codeup");
    expect(screen.getByRole("button", { name: "SLS" })).toHaveAttribute("data-product", "sls");
    expect(screen.getByRole("button", { name: "生产集群" })).toBeVisible();
    expect(screen.getByRole("button", { name: "收藏当前页面" })).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps product-region entries distinguishable when the sidebar is collapsed", async () => {
    installApi(populatedSnapshot({ sidebarCollapsed: true, favorites: [] }));
    render(<App />);

    const ackBeijing = await screen.findByRole("button", { name: "ACK · 北京" });
    const ackShanghai = screen.getByRole("button", { name: "ACK · 上海" });
    const kafkaBeijing = screen.getByRole("button", { name: "Kafka · 北京" });
    const mseBeijing = screen.getByRole("button", { name: "MSE · 北京" });
    const dms = screen.getByRole("button", { name: "DMS" });
    const codeup = screen.getByRole("button", { name: "Codeup" });
    const sls = screen.getByRole("button", { name: "SLS" });
    expect(ackBeijing).toHaveTextContent("北京");
    expect(ackShanghai).toHaveTextContent("上海");
    expect(kafkaBeijing).toHaveTextContent("北京");
    expect(mseBeijing).toHaveTextContent("北京");
    expect(dms).toHaveAttribute("data-product", "dms");
    expect(codeup).toHaveAttribute("data-product", "codeup");
    expect(sls).toHaveAttribute("data-product", "sls");
    expect(sls.querySelector('[data-entry-kind="query"]')).toBeNull();
    expect(ackBeijing.querySelector(".collapsed-region-label")).toHaveAttribute("aria-hidden", "true");
  });

  it("collapses regional product groups without hiding entries in compact sidebar mode", async () => {
    const user = userEvent.setup();
    const snapshot = populatedSnapshot({ favorites: [] });
    const { emitWorkspace } = installApi(snapshot);
    render(<App />);

    const ackBeijing = await screen.findByRole("button", { name: "ACK · 北京" });
    const kafkaBeijing = screen.getByRole("button", { name: "Kafka · 北京" });
    const toggle = screen.getByRole("button", { name: "折叠 ACK 地域" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(ackBeijing.closest(".nav-list")).not.toBeVisible();
    expect(kafkaBeijing).toBeVisible();

    act(() => emitWorkspace({ ...snapshot, sidebarCollapsed: true }));
    expect(ackBeijing.closest(".nav-list")).toBeVisible();
  });

  it("shows a quiet empty state while keeping launch entries in the sidebar", async () => {
    const snapshot = populatedSnapshot({ tabs: [], activeTabId: null, favorites: [] });
    installApi(snapshot);
    const { container } = render(<App />);

    await screen.findByRole("heading", { name: "选择一个控制台" });
    expect(screen.getByText(/从左侧选择模块/)).toHaveTextContent("⌘K");
    expect(container.querySelector(".entry-groups")).toBeNull();
    expect(screen.getByRole("button", { name: "控制台首页" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Codeup" })).toBeVisible();
  });

  it("opens the fixed console home from the sidebar footer", async () => {
    const user = userEvent.setup();
    const { dispatch } = installApi(populatedSnapshot({ tabs: [], activeTabId: null }));
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "控制台首页" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "open-console-home" });
  });

  it("opens a pasted console link from the unified toolbar palette", async () => {
    const user = userEvent.setup();
    const { dispatch } = installApi(populatedSnapshot());
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "打开链接" }));
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    const url = "https://flow.aliyun.com/pipelines/123";
    await user.type(within(dialog).getByPlaceholderText("搜索标签或操作，或粘贴控制台链接"), url);
    await user.click(within(dialog).getByText(url));

    expect(dispatch).toHaveBeenCalledWith({
      type: "open-pasted-url",
      url,
    });
  });

  it("opens the unified palette with Command+T from local and console focus", async () => {
    const user = userEvent.setup();
    const { emitConsoleShortcut } = installApi(populatedSnapshot());
    render(<App />);

    await screen.findByRole("button", { name: "打开链接" });
    fireEvent.keyDown(window, { key: "t", metaKey: true });
    expect(await screen.findByRole("dialog", { name: "快速切换" })).toBeVisible();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "快速切换" })).not.toBeInTheDocument());
    act(() => emitConsoleShortcut({ type: "open-link-opener" }));
    expect(await screen.findByRole("dialog", { name: "快速切换" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "快速切换" })).not.toBeInTheDocument());
  });

  it("manages selected modules and filters every product entry surface", async () => {
    const user = userEvent.setup();
    const snapshot = populatedSnapshot({ tabs: [], activeTabId: null, favorites: [] });
    const { dispatch, emitWorkspace } = installApi(snapshot);
    const { container } = render(<App />);

    await user.click(await screen.findByRole("button", { name: "管理模块" }));
    const settings = screen.getByRole("dialog", { name: "管理模块" });
    expect(settings).toHaveClass("module-settings-modal");
    await user.click(within(settings).getByRole("checkbox", { name: "ACK · 华北 2（北京）" }));
    await user.click(within(settings).getByRole("button", { name: /^Kafka2 个地域$/ }));
    await user.click(within(settings).getByRole("checkbox", { name: "Kafka · 华东 2（上海）" }));
    await user.click(within(settings).getByRole("button", { name: /^MSE2 个地域$/ }));
    expect(within(settings).getAllByRole("checkbox", { name: /^MSE · / })).toHaveLength(2);
    await user.click(within(settings).getByRole("checkbox", { name: "MSE · 华北 2（北京）" }));
    await user.click(within(settings).getByRole("checkbox", { name: "MSE 模块" }));
    expect(within(settings).getByRole("status", { name: "MSE 地域配置状态" })).toHaveTextContent(
      "启用 MSE 后可选择地域。",
    );
    await user.click(within(settings).getByRole("checkbox", { name: "MSE 模块" }));
    expect(within(settings).getByRole("group", { name: "MSE 地域配置" })).toBeVisible();

    for (const product of ["DMS", "Codeup", "SLS"]) {
      await user.click(within(settings).getByRole("button", { name: `${product}全局服务` }));
      const emptyState = within(settings).getByRole("status", {
        name: `${product} 地域配置状态`,
      });
      expect(emptyState).toHaveTextContent("地域配置全局服务");
      expect(emptyState).toHaveTextContent(`无需配置地域${product} 为全局服务。`);
      expect(within(settings).queryByRole("checkbox", { name: new RegExp(`^${product} ·`) }))
        .not.toBeInTheDocument();
    }
    await user.click(within(settings).getByRole("checkbox", { name: "SLS 模块" }));
    expect(within(settings).getByRole("status", { name: "SLS 地域配置状态" })).toHaveTextContent(
      "启用 SLS 后可使用全局服务。",
    );
    await user.click(within(settings).getByRole("checkbox", { name: "SLS 模块" }));
    for (const product of ["ACK", "Kafka", "DMS", "Codeup", "SLS"]) {
      await user.click(within(settings).getByRole("checkbox", { name: `${product} 模块` }));
    }
    await user.click(within(settings).getByRole("button", { name: "保存" }));

    const productRegionIds = {
      ack: ["cn-shanghai"],
      kafka: ["cn-beijing"],
      mse: ["cn-shanghai"] as ("cn-beijing" | "cn-shanghai")[],
    };
    expect(dispatch).toHaveBeenCalledWith({
      type: "set-module-settings",
      selectedProducts: ["mse"],
      productRegionIds,
    });
    act(() => emitWorkspace({
      ...snapshot,
      selectedProducts: ["mse"],
      productRegionIds,
    }));
    expect(screen.queryByRole("button", { name: "常用地域" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "ACK" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "MSE" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "DMS" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MSE · 上海" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "MSE · 北京" })).not.toBeInTheDocument();
    expect(container.querySelector(".entry-groups")).toBeNull();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const palette = await screen.findByRole("dialog", { name: "快速切换" });
    expect(within(palette).getAllByText("MSE")).toHaveLength(1);
    expect(within(palette).queryByText("ACK")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
  });

  it("selects only the matching SLS module shortcut", async () => {
    const slsTab = createTab({
      id: "sls-kol",
      product: "sls",
      regionId: null,
      url: "https://sls.console.aliyun.com/lognext/project/kol/logsearch/query?slsRegion=cn-beijing",
      title: "KOL",
    });
    installApi(populatedSnapshot({
      tabs: [slsTab],
      activeTabId: slsTab.id,
      favorites: [],
      moduleShortcuts: [{
        id: "sls-kol-shortcut",
        name: "KOL",
        product: "sls",
        url: slsTab.url,
        createdAt: 1,
      }],
    }));
    render(<App />);

    const profileEntry = await screen.findByRole("button", { name: "SLS" });
    const shortcutEntry = screen.getByRole("button", { name: "SLS · KOL" });
    expect(profileEntry).not.toHaveClass("selected");
    expect(shortcutEntry).toHaveClass("selected");
    expect(shortcutEntry).toHaveAttribute("aria-current", "page");
  });

  it.each([
    { product: "codeup" as const, label: "Codeup", url: "https://codeup.aliyun.com/org/sample-app" },
    { product: "sls" as const, label: "SLS", url: "https://sls.console.aliyun.com/lognext/project/demo/logsearch/sample-app" },
  ])("keeps only the $product shortcut selected after navigation and tab switching", async ({ product, label, url }) => {
    const shortcut = { id: "sample-app", name: "sample-app", product, url, createdAt: 1 };
    const tab = createTab({ id: "sample-app-tab", product, regionId: null, url, moduleShortcutId: shortcut.id });
    const otherTab = createTab({ id: "other-tab", product, regionId: null, url: `${url}/other`, moduleShortcutId: undefined });
    let snapshot = populatedSnapshot({ tabs: [tab, otherTab], activeTabId: tab.id, favorites: [], moduleShortcuts: [shortcut] });
    const { emitWorkspace } = installApi(snapshot);
    const { container } = render(<App />);
    const shortcutEntry = await screen.findByRole("button", { name: `${label} · sample-app` });
    const defaultEntry = screen.getByRole("button", { name: label });
    expect(shortcutEntry).toHaveClass("selected");

    snapshot = { ...snapshot, tabs: [{ ...tab, url: `${url}/commits?query=error#details` }, otherTab] };
    act(() => emitWorkspace(snapshot));
    expect(shortcutEntry).toHaveClass("selected");
    expect(shortcutEntry).toHaveAttribute("aria-current", "page");
    expect(defaultEntry).not.toHaveClass("selected");
    expect(container.querySelectorAll('.sidebar [aria-current="page"]')).toHaveLength(1);

    act(() => emitWorkspace({ ...snapshot, activeTabId: otherTab.id }));
    expect(shortcutEntry).not.toHaveClass("selected");
    expect(defaultEntry).toHaveClass("selected");
    act(() => emitWorkspace({ ...snapshot, sidebarCollapsed: true }));
    expect(shortcutEntry).toHaveClass("selected");
    expect(defaultEntry).not.toHaveClass("selected");

    act(() => emitWorkspace({ ...snapshot, moduleShortcuts: [] }));
    expect(defaultEntry).toHaveClass("selected");
    expect(screen.queryByRole("button", { name: `${label} · sample-app` })).not.toBeInTheDocument();
  });

  it("renders DMS tabs, context, and favorites without a region suffix", async () => {
    const dmsTab = createTab({
      id: "dms-tab",
      product: "dms",
      regionId: null,
      url: "https://dms.aliyun.com/",
      title: "DMS - Data Management Service",
    });
    const dmsFavorite = createFavorite({
      id: "dms-favorite",
      name: "SQL 窗口",
      product: "dms",
      regionId: null,
      url: "https://dmsnext.console.aliyun.com/workbench",
    });
    installApi(populatedSnapshot({
      tabs: [dmsTab],
      activeTabId: dmsTab.id,
      favorites: [dmsFavorite],
    }));
    const { container } = render(<App />);

    const tabButton = await screen.findByRole("tab", { name: "DMS - Data Management Service" });
    expect(tabButton).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "DMS" })).toHaveAttribute("aria-current", "page");
    expect(container.querySelector(".toolbar-context")).toHaveTextContent("DMS");
    expect(container.querySelector(".toolbar-context")).not.toHaveTextContent("·");
    expect(screen.getByRole("button", { name: "SQL 窗口" })).toBeVisible();
    expect(container).not.toHaveTextContent(/DMS ·|null|undefined/);
  });

  it("scrolls activated and newly created tabs into view", async () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const initial = populatedSnapshot();
    const { emitWorkspace } = installApi(initial);
    render(<App />);

    const ackTab = await screen.findByRole("tab", { name: "集群列表 · 北京" });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    }));
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(ackTab);

    scrollIntoView.mockClear();
    const activated = { ...initial, activeTabId: "kafka-tab" };
    act(() => emitWorkspace(activated));
    const kafkaTab = screen.getByRole("tab", { name: "消费者组 · 上海" });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
    expect(scrollIntoView.mock.contexts[0]).toBe(kafkaTab);

    scrollIntoView.mockClear();
    const newTab = createTab({
      id: "ack-shanghai-tab",
      regionId: "cn-shanghai",
      title: "上海集群",
      url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-shanghai",
    });
    act(() => emitWorkspace({ ...activated, tabs: [...activated.tabs, newTab] }));
    const newTabButton = screen.getByRole("tab", { name: "上海集群 · 上海" });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
    expect(scrollIntoView.mock.contexts[0]).toBe(newTabButton);
    scrollIntoView.mockRestore();
  });

  it("reorders tabs by dragging one tab onto another", async () => {
    const { dispatch } = installApi(populatedSnapshot());
    render(<App />);

    const ackButton = await screen.findByRole("tab", { name: "集群列表 · 北京" });
    const kafkaButton = screen.getByRole("tab", { name: "消费者组 · 上海" });
    const ackTab = ackButton.parentElement!;
    const kafkaTab = kafkaButton.parentElement!;
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      setData: vi.fn(),
    };

    fireEvent.dragStart(ackTab, { dataTransfer });
    expect(ackTab).toHaveClass("dragging");
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      "application/x-opsdock-tab",
      "ack-tab",
    );

    fireEvent.dragOver(kafkaTab, { dataTransfer });
    expect(kafkaTab).toHaveClass("drop-target");
    fireEvent.drop(kafkaTab, { dataTransfer });

    expect(dispatch).toHaveBeenCalledWith({
      type: "move-tab",
      tabId: "ack-tab",
      toIndex: 1,
    });
    expect(ackTab).not.toHaveClass("dragging");
    expect(kafkaTab).not.toHaveClass("drop-target");
  });

  it("reorders only from a focused tab button with exact keyboard modifiers", async () => {
    const { dispatch } = installApi(populatedSnapshot());
    render(<App />);

    const ackButton = await screen.findByRole("tab", { name: "集群列表 · 北京" });
    ackButton.focus();
    fireEvent.keyDown(ackButton, {
      key: "ArrowRight",
      altKey: true,
      shiftKey: true,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "move-tab",
      tabId: "ack-tab",
      toIndex: 1,
    });

    dispatch.mockClear();
    fireEvent.keyDown(ackButton, {
      key: "ArrowRight",
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
    });
    fireEvent.keyDown(window, {
      key: "ArrowRight",
      altKey: true,
      shiftKey: true,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("moves focus and activates tabs with standard tab-list keys", async () => {
    const { dispatch } = installApi(populatedSnapshot());
    render(<App />);

    const ackButton = await screen.findByRole("tab", { name: "集群列表 · 北京" });
    const kafkaButton = screen.getByRole("tab", { name: "消费者组 · 上海" });
    ackButton.focus();

    fireEvent.keyDown(ackButton, { key: "ArrowLeft" });
    expect(kafkaButton).toHaveFocus();
    expect(dispatch).toHaveBeenCalledWith({
      type: "activate-tab",
      tabId: "kafka-tab",
    });

    dispatch.mockClear();
    fireEvent.keyDown(kafkaButton, { key: "ArrowRight" });
    expect(ackButton).toHaveFocus();
    expect(dispatch).toHaveBeenCalledWith({
      type: "activate-tab",
      tabId: "ack-tab",
    });

    dispatch.mockClear();
    fireEvent.keyDown(ackButton, { key: "End" });
    expect(kafkaButton).toHaveFocus();
    expect(dispatch).toHaveBeenCalledWith({
      type: "activate-tab",
      tabId: "kafka-tab",
    });

    dispatch.mockClear();
    fireEvent.keyDown(kafkaButton, { key: "Home" });
    expect(ackButton).toHaveFocus();
    expect(dispatch).toHaveBeenCalledWith({
      type: "activate-tab",
      tabId: "ack-tab",
    });
  });

  it("pins tabs, cycles task state, and filters by the products actually open", async () => {
    const user = userEvent.setup();
    const initial = populatedSnapshot({
      tabs: [
        ...populatedSnapshot().tabs,
        createTab({
          id: "dms-tab",
          product: "dms",
          regionId: null,
          url: "https://dms.aliyun.com/",
          title: "SQL 工作台",
        }),
      ],
    });
    const { dispatch, emitWorkspace } = installApi(initial);
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "固定 集群列表" }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "set-tab-pinned",
      tabId: "ack-tab",
      pinned: true,
    });

    await user.click(screen.getByRole("button", { name: "集群列表任务状态：未标记" }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "set-tab-task-status",
      tabId: "ack-tab",
      taskStatus: "todo",
    });

    await user.selectOptions(screen.getByRole("combobox", { name: "按产品筛选标签" }), "kafka");
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "set-tab-filters",
      productFilter: "kafka",
      taskFilter: "all",
    });
    act(() => emitWorkspace({ ...initial, productFilter: "kafka" }));
    expect(screen.getByRole("tab", { name: "集群列表 · 北京" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "消费者组 · 上海" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "SQL 工作台" })).not.toBeInTheDocument();

    act(() => emitWorkspace({ ...initial, activeTabId: "kafka-tab", productFilter: "kafka" }));
    expect(screen.queryByRole("tab", { name: "集群列表 · 北京" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "消费者组 · 上海" })).toBeVisible();
  });

  it("filters the task queue and keeps keyboard switching inside the visible queue", async () => {
    const user = userEvent.setup();
    const tabs = [
      createTab({ taskStatus: "todo" }),
      createTab({
        id: "kafka-doing",
        product: "kafka",
        regionId: "cn-shanghai",
        title: "消费者组",
        url: "https://kafka.console.aliyun.com/region/cn-shanghai/instances/doing",
        taskStatus: "doing",
      }),
      createTab({
        id: "dms-doing",
        product: "dms",
        regionId: null,
        title: "SQL 工作台",
        url: "https://dms.aliyun.com/doing",
        taskStatus: "doing",
      }),
    ];
    const initial = populatedSnapshot({ tabs, activeTabId: "ack-tab" });
    const { dispatch, emitWorkspace } = installApi(initial);
    render(<App />);

    expect(await screen.findByRole("option", { name: "处理中 (2)" })).toBeVisible();
    await user.selectOptions(screen.getByRole("combobox", { name: "按任务状态筛选标签" }), "doing");
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "set-tab-filters",
      productFilter: "all",
      taskFilter: "doing",
    });
    act(() => emitWorkspace({ ...initial, taskFilter: "doing" }));
    expect(screen.getByRole("tab", { name: "集群列表 · 北京" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "消费者组 · 上海" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "SQL 工作台" })).toBeVisible();

    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "activate-tab", tabId: "kafka-doing" });

    act(() => emitWorkspace({ ...initial, activeTabId: "kafka-doing", taskFilter: "doing" }));
    expect(screen.queryByRole("tab", { name: "集群列表 · 北京" })).not.toBeInTheDocument();
    dispatch.mockClear();
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(dispatch).toHaveBeenCalledWith({ type: "activate-tab", tabId: "dms-doing" });
  });

  it("does not expose an address bar or download command", async () => {
    installApi(populatedSnapshot());
    render(<App />);

    await screen.findByRole("button", { name: "刷新" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /下载/ })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/地址|网址|URL/i)).not.toBeInTheDocument();
  });

  it("labels the toolbar actions with concise hover tooltips", async () => {
    installApi(populatedSnapshot());
    render(<App />);

    const expectedTooltips = [
      ["后退", "后退 (⌘[)"],
      ["前进", "前进 (⌘])"],
      ["收藏当前页面", "收藏当前页面 (⌘D)"],
      ["复制当前链接", "复制当前链接"],
      ["用默认浏览器打开", "用默认浏览器打开"],
      ["更多操作", "更多操作：账号密码、诊断与退出登录"],
    ];
    for (const [label, tooltip] of expectedTooltips) {
      const button = await screen.findByRole("button", { name: label });
      expect(button).toHaveAttribute("title", tooltip);
      expect(button.parentElement).toHaveAttribute("data-tooltip", tooltip);
    }
  });

  it("does not allow favoriting while the active console tab is authenticating", async () => {
    const authenticating = createTab({
      isAuthenticating: true,
      title: "阿里云-RAM用户登录",
    });
    installApi(populatedSnapshot({ tabs: [authenticating], activeTabId: authenticating.id }));
    render(<App />);

    const favorite = await screen.findByRole("button", { name: "收藏当前页面" });
    expect(favorite).toBeDisabled();
    expect(favorite.parentElement).toHaveAttribute("data-tooltip", "当前页面不可收藏");
    const copyLink = screen.getByRole("button", { name: "复制当前链接" });
    expect(copyLink).toBeDisabled();
    expect(copyLink.parentElement).toHaveAttribute("data-tooltip", "登录或外部页面链接不可复制");
    const openInBrowser = screen.getByRole("button", { name: "用默认浏览器打开" });
    expect(openInBrowser).toBeDisabled();
    expect(openInBrowser.parentElement).toHaveAttribute("data-tooltip", "登录或外部页面不能在浏览器中打开");
    expect(screen.getByRole("button", { name: "复制工作区上下文" })).toBeDisabled();
  });

  it("shows a compact login health action without hiding the remote login page", async () => {
    const user = userEvent.setup();
    const authenticating = createTab({
      isAuthenticating: true,
      externalHostname: "account.aliyun.com",
      title: "阿里云 RAM 用户登录",
    });
    const { setViewBounds } = installApi(populatedSnapshot({
      tabs: [authenticating],
      activeTabId: authenticating.id,
    }));
    render(<App />);

    const status = await screen.findByRole("button", { name: "更多操作" });
    expect(status).toHaveClass("needs-attention");
    await waitFor(() => expect(setViewBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      visible: true,
    })));
    await selectNativeMenu("credentials");
    const dialog = await screen.findByRole("dialog", { name: "记住账号密码" });
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
  });

  it("lets the user clear unreadable credentials instead of treating them as unconfigured", async () => {
    const user = userEvent.setup();
    const { api } = installApi(populatedSnapshot());
    vi.mocked(api.getLoginCredentials).mockRejectedValueOnce(new Error("cannot decrypt"));
    render(<App />);
    await selectNativeMenu("credentials");
    const dialog = await screen.findByRole("dialog", { name: "记住账号密码" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("无法读取或解密");
    await user.click(within(dialog).getByRole("button", { name: "清除已保存账密" }));
    expect(api.clearLoginCredentials).toHaveBeenCalledOnce();
    await waitFor(() => expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument());
  });

  it("shows and clears the real hostname as navigation enters and leaves an external page", async () => {
    const stable = createTab();
    const external = createTab({
      isAuthenticating: true,
      externalHostname: "idp.example.com",
      title: "Sign in",
    });
    const harness = installApi(populatedSnapshot({ tabs: [stable], activeTabId: stable.id }));
    const { container } = render(<App />);

    await screen.findByRole("button", { name: "刷新" });
    act(() => harness.emitWorkspace(populatedSnapshot({ tabs: [external], activeTabId: external.id })));
    expect(await screen.findByText("idp.example.com")).toBeVisible();
    const externalContext = container.querySelector(".toolbar-context.external-host");
    expect(externalContext).toHaveTextContent("idp.example.com");
    expect(externalContext).toHaveAttribute("title", "idp.example.com");
    expect(screen.getByRole("button", { name: "复制当前链接" })).toBeDisabled();

    act(() => harness.emitWorkspace(populatedSnapshot({ tabs: [stable], activeTabId: stable.id })));
    await waitFor(() => expect(container.querySelector(".toolbar-context.external-host")).not.toBeInTheDocument());
    expect(container.querySelector(".toolbar-context")).toHaveTextContent("ACK · 北京");
    expect(screen.getByRole("button", { name: "复制当前链接" })).toBeEnabled();
  });

  it("keeps the native console view visible while feedback is displayed in the toolbar", async () => {
    const { setViewBounds } = installApi(populatedSnapshot({ notice: "操作未完成" }));
    render(<App />);

    await screen.findByRole("status");
    await waitFor(() => expect(setViewBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      visible: true,
    })));
  });

  it("shows action errors and undo actions before ordinary workspace notices", async () => {
    const favorite = createFavorite();
    useRendererStore.setState({
      actionError: "关闭失败",
      removedFavorite: favorite,
    });
    installApi(populatedSnapshot({ notice: "普通通知" }));
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("关闭失败");
    expect(screen.queryByText("普通通知")).not.toBeInTheDocument();

    act(() => useRendererStore.setState({ actionError: null }));
    expect(await screen.findByRole("status")).toHaveTextContent("已删除收藏“生产集群”");
    expect(screen.queryByText("普通通知")).not.toBeInTheDocument();

    act(() => useRendererStore.setState({ removedFavorite: null }));
    expect(await screen.findByRole("status")).toHaveTextContent("普通通知");
  });

  it("uses sibling tab buttons and supports mouse and Command+W closing", async () => {
    const user = userEvent.setup();
    const { dispatch } = installApi(populatedSnapshot());
    render(<App />);

    const kafkaTab = await screen.findByRole("tab", { name: "消费者组 · 上海" });
    const kafkaClose = screen.getByRole("button", { name: "关闭 消费者组" });
    expect(kafkaTab).not.toContainElement(kafkaClose);
    expect(kafkaTab.parentElement).toContainElement(kafkaClose);

    await user.click(kafkaClose);
    expect(dispatch).toHaveBeenCalledWith({ type: "close-tab", tabId: "kafka-tab" });

    fireEvent.keyDown(window, { key: "w", metaKey: true });
    expect(dispatch).toHaveBeenCalledWith({ type: "close-tab", tabId: "ack-tab" });
  });

  it("finds text in the active page with browser-style controls", async () => {
    const user = userEvent.setup();
    const { api } = installApi(populatedSnapshot());
    vi.mocked(api.performViewAction).mockImplementation(async (action) =>
      action.type === "find"
        ? { tabId: "ack-tab", text: action.text, activeMatchOrdinal: 1, matches: 1 }
        : null);
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });

    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const findBar = await screen.findByRole("search", { name: "页内查找" });
    const input = within(findBar).getByRole("textbox", { name: "查找内容" });
    fireEvent.change(input, { target: { value: "集群" } });

    await waitFor(() => expect(api.performViewAction).toHaveBeenCalledWith({
      type: "find",
      text: "集群",
      forward: true,
      findNext: false,
    }));
    expect(await within(findBar).findByRole("status")).toHaveTextContent("1 / 1");

    await user.click(within(findBar).getByRole("button", { name: "下一个匹配项" }));
    await waitFor(() => expect(api.performViewAction).toHaveBeenLastCalledWith({
      type: "find",
      text: "集群",
      forward: true,
      findNext: true,
    }));

    input.focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("search", { name: "页内查找" })).not.toBeInTheDocument();
    expect(api.performViewAction).toHaveBeenLastCalledWith({ type: "stop-find", restoreFocus: true });
  });

  it("discards old find replies after a new query or tab switch", async () => {
    const initial = populatedSnapshot();
    const { api, emitWorkspace } = installApi(initial);
    const replies: Array<(result: { tabId: string; text: string; activeMatchOrdinal: number; matches: number }) => void> = [];
    vi.mocked(api.performViewAction).mockImplementation((action) => action.type === "find"
      ? new Promise((resolve) => replies.push(resolve))
      : Promise.resolve(null));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "页内查找" }));
    const bar = await screen.findByRole("search", { name: "页内查找" });
    const input = within(bar).getByRole("textbox", { name: "查找内容" });
    fireEvent.change(input, { target: { value: "old" } });
    await waitFor(() => expect(replies).toHaveLength(1));
    fireEvent.change(input, { target: { value: "new" } });
    await waitFor(() => expect(replies).toHaveLength(2));
    await act(async () => replies[1]({ tabId: "ack-tab", text: "new", activeMatchOrdinal: 1, matches: 2 }));
    await act(async () => replies[0]({ tabId: "ack-tab", text: "old", activeMatchOrdinal: 1, matches: 99 }));
    expect(within(bar).getByRole("status")).toHaveTextContent("1 / 2");
    fireEvent.change(input, { target: { value: "pending" } });
    await waitFor(() => expect(replies).toHaveLength(3));
    act(() => emitWorkspace({ ...initial, activeTabId: "kafka-tab" }));
    await act(async () => replies[2]({ tabId: "ack-tab", text: "pending", activeMatchOrdinal: 1, matches: 9 }));
    expect(screen.queryByRole("search", { name: "页内查找" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "页内查找" }));
    expect(screen.getByRole("textbox", { name: "查找内容" })).toHaveValue("");
  });

  it("applies the existing shortcut guards to events forwarded from a console view", async () => {
    const user = userEvent.setup();
    const { api, dispatch, emitConsoleShortcut } = installApi(populatedSnapshot());
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });

    act(() => emitConsoleShortcut({ type: "open-command-palette" }));
    const palette = await screen.findByRole("dialog", { name: "快速切换" });

    act(() => emitConsoleShortcut({ type: "close-active-tab" }));
    expect(dispatch).not.toHaveBeenCalledWith({ type: "close-tab", tabId: "ack-tab" });
    act(() => emitConsoleShortcut({ type: "activate-next-tab" }));
    expect(dispatch).not.toHaveBeenCalledWith({ type: "activate-tab", tabId: "kafka-tab" });
    act(() => emitConsoleShortcut({ type: "navigate-forward" }));
    expect(api.performViewAction).not.toHaveBeenCalledWith({ type: "forward" });
    act(() => emitConsoleShortcut({ type: "toggle-active-favorite" }));
    expect(screen.queryByRole("dialog", { name: "收藏当前页面" })).not.toBeInTheDocument();

    act(() => emitConsoleShortcut({ type: "reopen-closed-tab" }));
    expect(dispatch).not.toHaveBeenCalledWith({ type: "reopen-closed-tab" });

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "快速切换" })).not.toBeInTheDocument(),
    );
    act(() => emitConsoleShortcut({ type: "close-active-tab" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "close-tab", tabId: "ack-tab" });
  });

  it("navigates page history and toggles favorites with local and forwarded shortcuts", async () => {
    const user = userEvent.setup();
    const active = createTab({ canGoBack: true, canGoForward: true });
    const initial = populatedSnapshot({
      tabs: [active],
      activeTabId: active.id,
      favorites: [],
    });
    const { api, dispatch, emitConsoleShortcut, emitWorkspace } = installApi(initial);
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });

    fireEvent.keyDown(window, { key: "[", metaKey: true });
    expect(api.performViewAction).toHaveBeenCalledWith({ type: "back" });
    act(() => emitConsoleShortcut({ type: "navigate-forward" }));
    expect(api.performViewAction).toHaveBeenCalledWith({ type: "forward" });

    fireEvent.keyDown(window, { key: "d", metaKey: true });
    const editor = await screen.findByRole("dialog", { name: "收藏当前页面" });
    await user.click(within(editor).getByRole("button", { name: "取消" }));

    const favorite = createFavorite({ url: active.url });
    act(() => emitWorkspace({ ...initial, favorites: [favorite] }));
    act(() => emitConsoleShortcut({ type: "toggle-active-favorite" }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "remove-favorite",
      favoriteId: favorite.id,
    });
    expect(await screen.findByRole("status")).toHaveTextContent("已删除收藏“生产集群”");
  });

  it("navigates tabs with local and forwarded shortcuts", async () => {
    const tabs = Array.from({ length: 10 }, (_, index) => createTab({
      id: `tab-${index + 1}`,
      title: `标签 ${index + 1}`,
      createdAt: 100 + index,
      lastActiveAt: 200 - index,
    }));
    const { dispatch, emitConsoleShortcut } = installApi(populatedSnapshot({
      tabs,
      activeTabId: "tab-1",
      favorites: [],
    }));
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });

    fireEvent.keyDown(window, { key: "8", metaKey: true });
    expect(dispatch).toHaveBeenCalledWith({ type: "activate-tab", tabId: "tab-8" });

    fireEvent.keyDown(window, { key: "9", metaKey: true });
    expect(dispatch).toHaveBeenCalledWith({ type: "activate-tab", tabId: "tab-10" });

    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(dispatch).toHaveBeenCalledWith({ type: "activate-tab", tabId: "tab-2" });

    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    expect(dispatch).toHaveBeenCalledWith({ type: "activate-tab", tabId: "tab-10" });

    act(() => emitConsoleShortcut({ type: "activate-tab", position: 2 }));
    expect(dispatch).toHaveBeenCalledWith({ type: "activate-tab", tabId: "tab-2" });
    act(() => emitConsoleShortcut({ type: "activate-previous-tab" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "activate-tab", tabId: "tab-10" });
  });

  it("does not intercept shortcut near misses with extra modifiers", async () => {
    const { dispatch } = installApi(populatedSnapshot());
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });

    const commandDigit = new KeyboardEvent("keydown", {
      key: "2",
      metaKey: true,
      ctrlKey: true,
      cancelable: true,
    });
    window.dispatchEvent(commandDigit);
    const controlTab = new KeyboardEvent("keydown", {
      key: "Tab",
      ctrlKey: true,
      altKey: true,
      cancelable: true,
    });
    window.dispatchEvent(controlTab);

    expect(commandDigit.defaultPrevented).toBe(false);
    expect(controlTab.defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "activate-tab" }));
  });

  it("traps and restores modal focus, closes on Escape, and blocks Command+K", async () => {
    const user = userEvent.setup();
    installApi(populatedSnapshot());
    render(<App />);

    const settingsTrigger = await screen.findByRole("button", { name: "管理模块" });
    await user.click(settingsTrigger);
    const dialog = screen.getByRole("dialog", { name: "管理模块" });
    const firstProduct = within(dialog).getByRole("button", { name: /^ACK2 个地域$/ });
    const close = within(dialog).getByRole("button", { name: "关闭" });
    const save = within(dialog).getByRole("button", { name: "保存" });
    expect(firstProduct).toHaveFocus();

    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(save).toHaveFocus();
    fireEvent.keyDown(save, { key: "Tab" });
    expect(close).toHaveFocus();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog", { name: "快速切换" })).not.toBeInTheDocument();

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "管理模块" })).not.toBeInTheDocument();
    expect(settingsTrigger).toHaveFocus();
  });
});

describe("favorite editor", () => {
  it.each(["favorite", "shortcut"])("pins the %s editor target and ignores IME confirmation", async (kind) => {
    const first = createTab({ id: "first", product: "codeup", regionId: null, url: "https://codeup.aliyun.com/first", title: "原始页面" });
    const second = createTab({ id: "second", product: "codeup", regionId: null, url: "https://codeup.aliyun.com/second" });
    const snapshot = populatedSnapshot({ tabs: [first, second], activeTabId: first.id });
    const { dispatch, emitWorkspace } = installApi(snapshot);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: kind === "favorite" ? "收藏当前页面" : "保存模块快捷入口" }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "T", metaKey: true, shiftKey: true });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "reopen-closed-tab" });
    // External protocol activation can still arrive while the modal is open.
    act(() => emitWorkspace({ ...snapshot, activeTabId: second.id }));
    fireEvent.keyDown(input, { key: "Enter", isComposing: false });
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({
      type: kind === "favorite" ? "add-favorite" : "add-module-shortcut",
      tabId: first.id,
      name: "原始页面",
    }));
  });
  it("saves a Codeup page as a module shortcut from the toolbar", async () => {
    const user = userEvent.setup();
    const codeupTab = createTab({
      id: "codeup-tab",
      product: "codeup",
      regionId: null,
      url: "https://codeup.aliyun.com/org/sample-app/repository/123",
      title: "示例应用仓库",
    });
    const { dispatch } = installApi(populatedSnapshot({
      tabs: [codeupTab],
      activeTabId: codeupTab.id,
    }));
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "保存模块快捷入口" }));
    const dialog = screen.getByRole("dialog", { name: "保存模块快捷入口" });
    const input = within(dialog).getByRole("textbox", { name: "名称" });
    await user.clear(input);
    await user.type(input, "示例应用仓库");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));

    expect(dispatch).toHaveBeenCalledWith({
      type: "add-module-shortcut",
      tabId: "codeup-tab",
      name: "示例应用仓库",
    });
  });

  it("renames and removes a favorite through workspace commands", async () => {
    const user = userEvent.setup();
    const snapshot = populatedSnapshot();
    const { dispatch } = installApi(snapshot);
    render(<App />);
    await screen.findByRole("button", { name: "生产集群" });

    await selectNativeMenu("rename", "更多操作 生产集群");
    const dialog = screen.getByRole("dialog", { name: "重命名收藏" });
    const input = within(dialog).getByRole("textbox", { name: "名称" });
    await user.clear(input);
    await user.type(input, "核心生产集群");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));

    expect(dispatch).toHaveBeenCalledWith({
      type: "rename-favorite",
      favoriteId: "favorite-1",
      name: "核心生产集群",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "重命名收藏" })).not.toBeInTheDocument(),
    );

    await selectNativeMenu("remove", "更多操作 生产集群");
    expect(dispatch).toHaveBeenCalledWith({
      type: "remove-favorite",
      favoriteId: "favorite-1",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("已删除收藏“生产集群”");

    await user.click(screen.getByRole("button", { name: "撤销删除 生产集群" }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "restore-favorite",
      favoriteId: "favorite-1",
    });
    await waitFor(() => expect(screen.queryByText("已删除收藏“生产集群”")).not.toBeInTheDocument());
  });

  it("reorders favorites and module shortcuts and can undo shortcut deletion", async () => {
    const user = userEvent.setup();
    const snapshot = populatedSnapshot({
      favorites: [
        createFavorite({ id: "favorite-one", name: "收藏一" }),
        createFavorite({
          id: "favorite-two",
          name: "收藏二",
          url: "https://cs.console.aliyun.com/#/k8s/cluster/detail/two?region=cn-beijing",
        }),
      ],
      moduleShortcuts: [
        {
          id: "shortcut-one",
          name: "流水线一",
          product: "codeup",
          url: "https://flow.aliyun.com/pipelines/one",
          createdAt: 1,
        },
        {
          id: "shortcut-two",
          name: "流水线二",
          product: "codeup",
          url: "https://flow.aliyun.com/pipelines/two",
          createdAt: 2,
        },
      ],
    });
    const { dispatch } = installApi(snapshot);
    render(<App />);

    await selectNativeMenu("move-down", "更多操作 收藏一");
    expect(dispatch).toHaveBeenCalledWith({
      type: "move-favorite",
      favoriteId: "favorite-one",
      toIndex: 1,
    });

    await selectNativeMenu("move-down", "更多操作 流水线一");
    expect(dispatch).toHaveBeenCalledWith({
      type: "move-module-shortcut",
      shortcutId: "shortcut-one",
      toIndex: 1,
    });

    await selectNativeMenu("remove", "更多操作 流水线一");
    expect(dispatch).toHaveBeenCalledWith({
      type: "remove-module-shortcut",
      shortcutId: "shortcut-one",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("已删除快捷入口“流水线一”");
    await user.click(screen.getByRole("button", { name: "撤销删除 流水线一" }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "restore-module-shortcut",
      shortcutId: "shortcut-one",
    });
  });

  it("keeps the editor open and allows retrying after an IPC failure", async () => {
    const user = userEvent.setup();
    const { dispatch } = installApi(populatedSnapshot());
    dispatch.mockRejectedValueOnce(new Error("IPC unavailable"));
    render(<App />);

    await selectNativeMenu("rename", "更多操作 生产集群");
    const dialog = screen.getByRole("dialog", { name: "重命名收藏" });
    const save = within(dialog).getByRole("button", { name: "保存" });
    await user.click(save);

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("收藏保存失败，请重试");
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

describe("recoverable workspace actions", () => {
  it("fills the default region and keeps product settings open when enabling MSE is rejected", async () => {
    const user = userEvent.setup();
    const snapshot = populatedSnapshot({
      selectedProducts: ["ack"],
      productRegionIds: {
        ack: ["cn-hangzhou"],
        kafka: ["cn-hangzhou"],
        mse: [],
      },
    });
    const { dispatch } = installApi(snapshot);
    dispatch.mockResolvedValueOnce({
      ok: false,
      error: "MSE 仅支持北京和上海，请至少选择其中一个地域",
    });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "管理模块" }));
    const dialog = screen.getByRole("dialog", { name: "管理模块" });
    expect(within(dialog).getByRole("group", { name: "ACK 地域配置" })).toBeVisible();
    await user.click(within(dialog).getByRole("checkbox", { name: "MSE 模块" }));
    expect(within(dialog).getByRole("group", { name: "ACK 地域配置" })).toBeVisible();
    expect(within(dialog).queryByRole("group", { name: "MSE 地域配置" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /^MSE1 个地域$/ }));
    const mseBeijing = within(dialog).getByRole("checkbox", { name: "MSE · 华北 2（北京）" });
    expect(mseBeijing).toBeChecked();
    expect(mseBeijing).toBeDisabled();
    const save = within(dialog).getByRole("button", { name: "保存" });
    await user.click(save);

    expect(dispatch).toHaveBeenCalledWith({
      type: "set-module-settings",
      selectedProducts: ["ack", "mse"],
      productRegionIds: {
        ack: ["cn-hangzhou"],
        kafka: ["cn-hangzhou"],
        mse: ["cn-beijing"],
      },
    });

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "MSE 仅支持北京和上海，请至少选择其中一个地域",
    );
    await waitFor(() => expect(save).toBeEnabled());
    expect(dialog).toBeInTheDocument();
  });

  it("keeps module settings open when the backend rejects the change", async () => {
    const user = userEvent.setup();
    const snapshot = populatedSnapshot();
    const { dispatch } = installApi(snapshot);
    dispatch.mockResolvedValueOnce({ ok: false, error: "地域无权限" });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "管理模块" }));
    const dialog = screen.getByRole("dialog", { name: "管理模块" });
    await user.click(within(dialog).getByRole("checkbox", { name: "ACK · 华北 2（北京）" }));
    const save = within(dialog).getByRole("button", { name: "保存" });
    await user.click(save);

    expect(dispatch).toHaveBeenCalledWith({
      type: "set-module-settings",
      selectedProducts: snapshot.selectedProducts,
      productRegionIds: {
        ...snapshot.productRegionIds,
        ack: ["cn-shanghai"],
      },
    });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("地域无权限");
    await waitFor(() => expect(save).toBeEnabled());
    expect(dialog).toBeInTheDocument();
  });

  it("shows toolbar IPC failures without leaving an unhandled rejection", async () => {
    const user = userEvent.setup();
    const { api } = installApi(populatedSnapshot());
    vi.mocked(api.performViewAction).mockRejectedValueOnce(new Error("view unavailable"));
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "刷新" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("控制台操作失败，请重试");
    expect(api.performViewAction).toHaveBeenCalledWith({ type: "reload" });
  });

  it("copies a privacy-safe diagnostic summary through the main process", async () => {
    const user = userEvent.setup();
    const { api } = installApi(populatedSnapshot());
    render(<App />);

    await selectNativeMenu("diagnostics");

    expect(api.copyDiagnostics).toHaveBeenCalledOnce();
  });

  it("copies the current workspace context through the main process", async () => {
    const user = userEvent.setup();
    const { api } = installApi(populatedSnapshot());
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "复制工作区上下文" }));

    expect(api.copyWorkspaceContext).toHaveBeenCalledOnce();
  });
});

describe("Command+K local switcher", () => {
  it("selects the current tab rather than a state-changing action by default", async () => {
    const user = userEvent.setup();
    const { dispatch } = installApi(populatedSnapshot());
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = await screen.findByRole("combobox");
    await waitFor(() => expect(document.querySelector('[cmdk-item][data-selected="true"]')).toHaveAttribute("data-value", "tab:ack-tab"));
    await user.click(input);
    await user.keyboard("{Enter}");
    expect(dispatch).toHaveBeenCalledWith({ type: "activate-tab", tabId: "ack-tab" });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "set-tab-task-status" }));
  });

  it("does not offer workspace context copying on external pages", async () => {
    const active = createTab({ isAuthenticating: true, externalHostname: "signin.aliyun.com" });
    installApi(populatedSnapshot({ tabs: [active], activeTabId: active.id }));
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });
    expect(screen.getByRole("button", { name: "复制工作区上下文" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    expect(within(dialog).queryByText("复制工作区上下文")).not.toBeInTheDocument();
  });
  it("keeps Command+K empty and only prefills the link-opener mode", async () => {
    const user = userEvent.setup();
    const { api } = installApi(populatedSnapshot());
    const url = "https://flow.aliyun.com/pipelines/clipboard";
    vi.mocked(api.getClipboardConsoleUrls).mockResolvedValue([url]);
    render(<App />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    let dialog = await screen.findByRole("dialog", { name: "快速切换" });
    let input = within(dialog).getByPlaceholderText("搜索标签或操作，或粘贴控制台链接");
    expect(input).toHaveValue("");
    expect(api.getClipboardConsoleUrls).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");

    fireEvent.keyDown(window, { key: "t", metaKey: true });
    dialog = await screen.findByRole("dialog", { name: "快速切换" });
    input = within(dialog).getByPlaceholderText("搜索标签或操作，或粘贴控制台链接");
    await waitFor(() => expect(input).toHaveValue(url));
    expect(api.getClipboardConsoleUrls).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}");
  });

  it("prefills a recognized clipboard URL and opens it through the trusted command", async () => {
    const user = userEvent.setup();
    const snapshot = populatedSnapshot();
    const { api, dispatch } = installApi(snapshot);
    const url = "https://flow.aliyun.com/pipelines/clipboard";
    vi.mocked(api.getClipboardConsoleUrls).mockResolvedValue([url]);
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "打开链接" }));
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    const input = within(dialog).getByPlaceholderText("搜索标签或操作，或粘贴控制台链接");
    await waitFor(() => expect(input).toHaveValue(url));
    await user.click(within(dialog).getByText(url));

    expect(dispatch).toHaveBeenCalledWith({ type: "open-pasted-url", url });
  });

  it("previews and opens all deduplicated clipboard links in one command", async () => {
    const user = userEvent.setup();
    const { api, dispatch } = installApi(populatedSnapshot());
    const urls = [
      "https://flow.aliyun.com/pipelines/clipboard",
      "https://sls.console.aliyun.com/lognext/project/demo/logsearch/app",
    ];
    vi.mocked(api.getClipboardConsoleUrls).mockResolvedValue(urls);
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "打开链接" }));
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    expect(await within(dialog).findByText("打开全部 2 个链接")).toBeVisible();
    expect(within(dialog).getByText(urls[0])).toBeVisible();
    expect(within(dialog).getByText(urls[1])).toBeVisible();
    await user.click(within(dialog).getByText("打开全部 2 个链接"));

    expect(dispatch).toHaveBeenCalledWith({ type: "open-pasted-urls", urls });
  });

  it("retries all failed tabs from the common actions", async () => {
    const user = userEvent.setup();
    const snapshot = populatedSnapshot({
      tabs: [
        createTab({ loadState: "error" }),
        createTab({ id: "crashed", loadState: "crashed" }),
      ],
    });
    const { api } = installApi(snapshot);
    render(<App />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    await user.click(within(dialog).getByText("顺序重试失败标签"));

    expect(api.retryFailedTabs).toHaveBeenCalledOnce();
  });

  it("includes module shortcuts and recent visits grouped by product", async () => {
    const user = userEvent.setup();
    const snapshot = populatedSnapshot({
      moduleShortcuts: [{
        id: "codeup-shortcut",
        name: "核心流水线",
        product: "codeup",
        url: "https://flow.aliyun.com/pipelines/core",
        createdAt: 1,
      }],
      recentVisits: [{
        product: "sls",
        regionId: null,
        url: "https://sls.console.aliyun.com/lognext/project/sample-app/logsearch/query?token=secret",
        title: "示例应用查询",
        visitedAt: 500,
      }],
    });
    const { dispatch } = installApi(snapshot);
    render(<App />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    let dialog = await screen.findByRole("dialog", { name: "快速切换" });
    expect(within(dialog).getByText("模块快捷入口")).toBeVisible();
    expect(within(dialog).getByText("最近访问 · SLS")).toBeVisible();
    const recentItem = within(dialog).getByText("示例应用查询").closest("[cmdk-item]");
    expect(recentItem).toHaveAttribute("data-value", "recent:sls:0");
    await user.click(within(dialog).getByText("核心流水线"));
    expect(dispatch).toHaveBeenCalledWith({
      type: "open-url",
      product: "codeup",
      regionId: null,
      url: "https://flow.aliyun.com/pipelines/core",
      title: "核心流水线",
    });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    dialog = await screen.findByRole("dialog", { name: "快速切换" });
    await user.click(within(dialog).getByText("示例应用查询"));
    expect(dispatch).toHaveBeenCalledWith({
      type: "open-url",
      product: "sls",
      regionId: null,
      url: "https://sls.console.aliyun.com/lognext/project/sample-app/logsearch/query?token=secret",
      title: "示例应用查询",
    });
  });

  it("shows five recent visits per product until a query searches the full history", async () => {
    const user = userEvent.setup();
    const recentVisits = Array.from({ length: 6 }, (_, index) => ({
      product: "sls" as const,
      regionId: null,
      url: `https://sls.console.aliyun.com/lognext/project/history-${index + 1}/logsearch/query`,
      title: `历史查询 ${index + 1}`,
      visitedAt: 600 - index,
    }));
    installApi(populatedSnapshot({ recentVisits }));
    render(<App />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    expect(within(dialog).getByText("历史查询 5")).toBeVisible();
    expect(within(dialog).queryByText("历史查询 6")).not.toBeInTheDocument();

    await user.type(
      within(dialog).getByPlaceholderText("搜索标签或操作，或粘贴控制台链接"),
      "历史查询 6",
    );
    expect(await within(dialog).findByText("历史查询 6")).toBeVisible();
    expect(within(dialog).queryByText("历史查询 5")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
  });

  it("searches recently closed tabs and reopens the selected tab", async () => {
    const user = userEvent.setup();
    const recentlyClosedTabs = [
      createTab({ id: "closed-one", title: "旧集群一" }),
      createTab({
        id: "closed-two",
        title: "旧集群二",
        url: "https://cs.console.aliyun.com/#/k8s/cluster/detail/closed-two?region=cn-beijing",
      }),
    ];
    const { dispatch } = installApi(populatedSnapshot({ recentlyClosedTabs }));
    render(<App />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    await user.type(
      within(dialog).getByPlaceholderText("搜索标签或操作，或粘贴控制台链接"),
      "旧集群二",
    );
    await user.click(within(dialog).getByText("旧集群二 · 北京"));

    expect(dispatch).toHaveBeenCalledWith({
      type: "reopen-closed-tab",
      tabId: "closed-two",
    });
  });

  it("exposes common current-page and batch actions on an empty query", async () => {
    const user = userEvent.setup();
    const active = createTab({
      id: "codeup-active",
      product: "codeup",
      regionId: null,
      title: "核心仓库",
      url: "https://codeup.aliyun.com/org/opsdock/repository/1",
    });
    const tabs = [
      active,
      createTab({ id: "done-tab", taskStatus: "done", pinned: true }),
      createTab({ id: "unpinned-tab", title: "未固定标签" }),
    ];
    const { api, dispatch } = installApi(populatedSnapshot({
      tabs,
      activeTabId: active.id,
      favorites: [],
    }));
    render(<App />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    let dialog = await screen.findByRole("dialog", { name: "快速切换" });
    for (const label of [
      "完成当前并切到下一条",
      "收藏当前页面",
      "保存模块快捷入口",
      "复制当前链接",
      "用默认浏览器打开",
      "关闭其他标签",
      "关闭已完成标签",
      "关闭未固定标签",
    ]) {
      expect(within(dialog).getByText(label)).toBeVisible();
    }

    await user.type(
      within(dialog).getByPlaceholderText("搜索标签或操作，或粘贴控制台链接"),
      "复制当前链接",
    );
    expect(within(dialog).queryByText("关闭其他标签")).not.toBeInTheDocument();
    await user.click(within(dialog).getByText("复制当前链接"));
    expect(api.performViewAction).toHaveBeenCalledWith({ type: "copy-link" });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    dialog = await screen.findByRole("dialog", { name: "快速切换" });
    await user.click(within(dialog).getByText("关闭已完成标签"));
    expect(dispatch).toHaveBeenCalledWith({ type: "close-tabs", scope: "completed" });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    dialog = await screen.findByRole("dialog", { name: "快速切换" });
    await user.click(within(dialog).getByText("收藏当前页面"));
    let editor = await screen.findByRole("dialog", { name: "收藏当前页面" });
    await user.click(within(editor).getByRole("button", { name: "取消" }));

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    dialog = await screen.findByRole("dialog", { name: "快速切换" });
    await user.click(within(dialog).getByText("保存模块快捷入口"));
    editor = await screen.findByRole("dialog", { name: "保存模块快捷入口" });
    await user.click(within(editor).getByRole("button", { name: "取消" }));
  });

  it("completes the active filtered task and advances to the next actionable tab", async () => {
    const user = userEvent.setup();
    const tabs = [
      createTab({ id: "current", taskStatus: "doing", title: "当前任务" }),
      createTab({ id: "done", taskStatus: "done", title: "已办任务" }),
      createTab({ id: "other-product", product: "kafka", taskStatus: "doing", title: "Kafka 任务" }),
      createTab({ id: "next", taskStatus: "doing", title: "下一任务" }),
    ];
    const initial = populatedSnapshot({
      tabs,
      activeTabId: "current",
      favorites: [],
    });
    const { dispatch, emitWorkspace } = installApi(initial);
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });

    await user.selectOptions(screen.getByRole("combobox", { name: "按产品筛选标签" }), "ack");
    act(() => emitWorkspace({ ...initial, productFilter: "ack" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "按任务状态筛选标签" }), "doing");
    act(() => emitWorkspace({ ...initial, productFilter: "ack", taskFilter: "doing" }));
    dispatch.mockClear();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    const action = within(dialog).getByText("完成当前并切到下一条").closest<HTMLElement>("[cmdk-item]");
    expect(action?.querySelector("small")).toHaveTextContent("下一任务 · 北京");
    await user.click(action!);

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatch.mock.calls.map(([command]) => command)).toEqual([
      { type: "set-tab-task-status", tabId: "current", taskStatus: "done" },
      { type: "activate-tab", tabId: "next" },
    ]);
  });

  it("does not advance when completing the active task fails", async () => {
    const user = userEvent.setup();
    const snapshot = populatedSnapshot({
      tabs: [
        createTab({ id: "current", taskStatus: "doing" }),
        createTab({ id: "next", taskStatus: "doing" }),
      ],
      activeTabId: "current",
      favorites: [],
    });
    const { dispatch } = installApi(snapshot);
    dispatch.mockResolvedValueOnce({ ok: false, error: "状态保存失败" });
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    await user.click(within(dialog).getByText("完成当前并切到下一条"));

    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch).toHaveBeenCalledWith({
      type: "set-tab-task-status",
      tabId: "current",
      taskStatus: "done",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("状态保存失败");
  });

  it("only completes the active task when no other actionable tab is visible", async () => {
    const user = userEvent.setup();
    const snapshot = populatedSnapshot({
      tabs: [
        createTab({ id: "current", taskStatus: "doing" }),
        createTab({ id: "done", taskStatus: "done" }),
      ],
      activeTabId: "current",
      favorites: [],
    });
    const { dispatch, emitWorkspace } = installApi(snapshot);
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });

    await user.selectOptions(screen.getByRole("combobox", { name: "按任务状态筛选标签" }), "doing");
    act(() => emitWorkspace({ ...snapshot, taskFilter: "doing" }));
    dispatch.mockClear();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    const action = within(dialog).getByText("完成当前并切到下一条").closest<HTMLElement>("[cmdk-item]");
    expect(action?.querySelector("small")).toHaveTextContent("仅标记当前");
    await user.click(action!);

    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch).toHaveBeenCalledWith({
      type: "set-tab-task-status",
      tabId: "current",
      taskStatus: "done",
    });
  });

  it("removes the active favorite from the common actions", async () => {
    const user = userEvent.setup();
    const active = createTab();
    const favorite = createFavorite({ url: active.url });
    const { dispatch } = installApi(populatedSnapshot({
      tabs: [active],
      activeTabId: active.id,
      favorites: [favorite],
    }));
    render(<App />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    await user.click(within(dialog).getByText("取消收藏当前页面"));

    expect(dispatch).toHaveBeenCalledWith({
      type: "remove-favorite",
      favoriteId: favorite.id,
    });
  });

  it("lazy-loads with focus, hides the console, and resets between opens", async () => {
    const user = userEvent.setup();
    const { setViewBounds } = installApi(populatedSnapshot());
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });
    expect(screen.queryByRole("dialog", { name: "快速切换" })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() =>
      expect(setViewBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false })),
    );
    let dialog = await screen.findByRole("dialog", { name: "快速切换" });
    let input = within(dialog).getByPlaceholderText("搜索标签或操作，或粘贴控制台链接");
    expect(input).toHaveFocus();
    await user.type(input, "消费者组");

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "快速切换" })).not.toBeInTheDocument(),
    );

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    dialog = await screen.findByRole("dialog", { name: "快速切换" });
    input = within(dialog).getByPlaceholderText("搜索标签或操作，或粘贴控制台链接");
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    await user.keyboard("{Escape}");
  });

  it("filters local tab data and activates the selected tab", async () => {
    const user = userEvent.setup();
    const snapshot = populatedSnapshot();
    const { dispatch } = installApi(snapshot);
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    await user.type(
      within(dialog).getByPlaceholderText("搜索标签或操作，或粘贴控制台链接"),
      "消费者组",
    );
    expect(within(dialog).queryByText("集群列表 · 北京")).not.toBeInTheDocument();
    await user.click(within(dialog).getByText("消费者组 · 上海"));

    expect(dispatch).toHaveBeenCalledWith({
      type: "activate-tab",
      tabId: "kafka-tab",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "快速切换" })).not.toBeInTheDocument(),
    );
  });

  it("prioritizes actionable tabs and disambiguates duplicate titles by URL path", async () => {
    const tabs = [
      createTab({
        id: "recent",
        product: "sls",
        regionId: null,
        title: "日志服务",
        url: "https://sls.console.aliyun.com/lognext/project/recent/logsearch/query?slsRegion=cn-beijing",
        lastActiveAt: 600,
      }),
      createTab({
        id: "done",
        product: "sls",
        regionId: null,
        title: "日志服务",
        url: "https://sls.console.aliyun.com/lognext/project/done/logsearch/query?slsRegion=cn-beijing",
        lastActiveAt: 900,
        taskStatus: "done",
      }),
      createTab({
        id: "todo",
        product: "sls",
        regionId: null,
        title: "日志服务",
        url: "https://sls.console.aliyun.com/lognext/project/todo/logsearch/query?slsRegion=cn-beijing",
        lastActiveAt: 200,
        taskStatus: "todo",
      }),
      createTab({
        id: "doing",
        product: "sls",
        regionId: null,
        title: "日志服务",
        url: "https://sls.console.aliyun.com/lognext/project/doing/logsearch/query?slsRegion=cn-beijing",
        lastActiveAt: 100,
        taskStatus: "doing",
      }),
      createTab({
        id: "pinned",
        product: "sls",
        regionId: null,
        title: "日志服务",
        url: "https://sls.console.aliyun.com/lognext/project/pinned/logsearch/query?slsRegion=cn-beijing",
        lastActiveAt: 10,
        pinned: true,
      }),
      createTab({
        id: "active",
        product: "sls",
        regionId: null,
        title: "日志服务",
        url: "https://sls.console.aliyun.com/lognext/project/active/logsearch/query?slsRegion=cn-beijing",
        lastActiveAt: 1,
      }),
    ];
    installApi(populatedSnapshot({ tabs, activeTabId: "active" }));
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    const group = within(dialog).getByText("打开的标签").closest("[cmdk-group]");
    expect(group).not.toBeNull();
    const rows = [...group!.querySelectorAll<HTMLElement>("[cmdk-item]")];

    expect(rows.map((row) => row.getAttribute("data-value"))).toEqual([
      "tab:active",
      "tab:pinned",
      "tab:doing",
      "tab:todo",
      "tab:recent",
      "tab:done",
    ]);
    expect(new Set(rows.map((row) => row.getAttribute("data-value"))).size).toBe(rows.length);
    expect(rows[0].querySelector("small")).toHaveTextContent(
      "当前 · SLS · sls.console.aliyun.com/lognext/project/active/logsearch/query",
    );
    expect(rows[0].querySelector("small")).not.toHaveTextContent("slsRegion");
  });

  it.each([
    {
      query: "固定: 集群",
      label: "固定 集群列表 · 北京",
      tab: createTab(),
      command: { type: "set-tab-pinned", tabId: "ack-tab", pinned: true },
    },
    {
      query: "取消固定: 集群",
      label: "取消固定 集群列表 · 北京",
      tab: createTab({ pinned: true }),
      command: { type: "set-tab-pinned", tabId: "ack-tab", pinned: false },
    },
    {
      query: "待处理: 集群",
      label: "标记为待处理 集群列表 · 北京",
      tab: createTab(),
      command: { type: "set-tab-task-status", tabId: "ack-tab", taskStatus: "todo" },
    },
    {
      query: "处理中: 集群",
      label: "标记为处理中 集群列表 · 北京",
      tab: createTab(),
      command: { type: "set-tab-task-status", tabId: "ack-tab", taskStatus: "doing" },
    },
    {
      query: "已完成: 集群",
      label: "标记为已完成 集群列表 · 北京",
      tab: createTab(),
      command: { type: "set-tab-task-status", tabId: "ack-tab", taskStatus: "done" },
    },
    {
      query: "清除状态: 集群",
      label: "清除任务状态 集群列表 · 北京",
      tab: createTab({ taskStatus: "doing" }),
      command: { type: "set-tab-task-status", tabId: "ack-tab", taskStatus: null },
    },
    {
      query: "关闭: 集群",
      label: "关闭 集群列表 · 北京",
      tab: createTab(),
      command: { type: "close-tab", tabId: "ack-tab" },
    },
  ])("runs the $query command for one explicit tab", async ({ query, label, tab, command }) => {
    const user = userEvent.setup();
    const { dispatch } = installApi(populatedSnapshot({
      tabs: [
        tab,
        createTab({
          id: "ack-other",
          title: "其他集群",
          url: "https://cs.console.aliyun.com/#/k8s/cluster/detail/other?region=cn-beijing",
        }),
      ],
      activeTabId: tab.id,
    }));
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    await user.type(
      within(dialog).getByPlaceholderText("搜索标签或操作，或粘贴控制台链接"),
      query,
    );
    await user.click(within(dialog).getByText(label));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(command);
  });

  it("keeps action-like tab titles searchable unless an action colon is present", async () => {
    const user = userEvent.setup();
    const tab = createTab({ title: "关闭 集群" });
    const { dispatch } = installApi(populatedSnapshot({ tabs: [tab], activeTabId: tab.id }));
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    await user.type(
      within(dialog).getByPlaceholderText("搜索标签或操作，或粘贴控制台链接"),
      "关闭 集群",
    );

    expect(within(dialog).queryByText("标签操作")).not.toBeInTheDocument();
    const tabGroup = within(dialog).getByText("打开的标签").closest<HTMLElement>("[cmdk-group]");
    expect(tabGroup).not.toBeNull();
    await user.click(within(tabGroup!).getByText("关闭 集群 · 北京"));
    expect(dispatch).toHaveBeenCalledWith({ type: "activate-tab", tabId: tab.id });
  });

  it("disambiguates same-named shortcuts and searches them by URL path", async () => {
    const user = userEvent.setup();
    const shortcuts = [
      {
        id: "pipeline-one",
        name: "同名流水线",
        product: "codeup" as const,
        url: "https://flow.aliyun.com/pipelines/one",
        createdAt: 1,
      },
      {
        id: "pipeline-two",
        name: "同名流水线",
        product: "codeup" as const,
        url: "https://flow.aliyun.com/pipelines/two",
        createdAt: 2,
      },
    ];
    const { dispatch } = installApi(populatedSnapshot({ moduleShortcuts: shortcuts }));
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    const input = within(dialog).getByPlaceholderText("搜索标签或操作，或粘贴控制台链接");
    await user.type(input, "同名流水线");
    const items = within(dialog).getAllByText("同名流水线")
      .map((item) => item.closest<HTMLElement>("[cmdk-item]"));
    expect(items.map((item) => item?.getAttribute("data-value"))).toEqual([
      "shortcut:pipeline-one",
      "shortcut:pipeline-two",
    ]);
    expect(items[0]?.querySelector("small")).toHaveTextContent("flow.aliyun.com/pipelines/one");
    expect(items[1]?.querySelector("small")).toHaveTextContent("flow.aliyun.com/pipelines/two");

    await user.clear(input);
    await user.type(input, "pipelines/two");
    expect(within(dialog).getAllByText("同名流水线")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(dispatch).toHaveBeenCalledWith({
      type: "open-url",
      product: "codeup",
      regionId: null,
      url: "https://flow.aliyun.com/pipelines/two",
      title: "同名流水线",
    });
  });

  it("disambiguates same-named favorites and searches them by URL path", async () => {
    const user = userEvent.setup();
    const favorites = [
      createFavorite({
        id: "favorite-one",
        name: "同名集群",
        url: "https://cs.console.aliyun.com/#/k8s/cluster/detail/one?region=cn-beijing",
      }),
      createFavorite({
        id: "favorite-two",
        name: "同名集群",
        url: "https://cs.console.aliyun.com/#/k8s/cluster/detail/two?region=cn-beijing",
      }),
    ];
    const { dispatch } = installApi(populatedSnapshot({ favorites }));
    render(<App />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    const input = within(dialog).getByPlaceholderText("搜索标签或操作，或粘贴控制台链接");
    await user.type(input, "cluster/detail/two");

    const favorite = within(dialog).getByText("同名集群").closest<HTMLElement>("[cmdk-item]");
    expect(favorite).toHaveAttribute("data-value", "favorite:favorite-two");
    expect(favorite?.querySelector("small")).toHaveTextContent(
      "cs.console.aliyun.com/k8s/cluster/detail/two",
    );
    await user.keyboard("{Enter}");
    expect(dispatch).toHaveBeenCalledWith({
      type: "open-url",
      product: "ack",
      regionId: "cn-beijing",
      url: "https://cs.console.aliyun.com/#/k8s/cluster/detail/two?region=cn-beijing",
      title: "同名集群",
    });
  });

  it("offers exactly one Codeup product entry and opens it without a region", async () => {
    const user = userEvent.setup();
    const { dispatch } = installApi(populatedSnapshot());
    render(<App />);
    await screen.findByRole("button", { name: "刷新" });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "快速切换" });
    const input = within(dialog).getByPlaceholderText("搜索标签或操作，或粘贴控制台链接");
    await user.type(input, "Codeup");
    const codeupEntries = within(dialog).getAllByText("Codeup");
    expect(codeupEntries).toHaveLength(1);
    await user.click(codeupEntries[0]);

    expect(dispatch).toHaveBeenCalledWith({
      type: "open-entry",
      product: "codeup",
      regionId: null,
    });
  });

});

describe("logout confirmation", () => {
  it("requires confirmation before clearing the RAM session", async () => {
    const user = userEvent.setup();
    const { logout } = installApi(populatedSnapshot());
    render(<App />);
    await selectNativeMenu("logout");
    let dialog = screen.getByRole("dialog", { name: "退出 RAM 登录" });
    expect(within(dialog).getByText(/关闭所有控制台标签/)).toBeVisible();
    expect(logout).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(logout).not.toHaveBeenCalled();

    await selectNativeMenu("logout");
    dialog = screen.getByRole("dialog", { name: "退出 RAM 登录" });
    await user.click(within(dialog).getByRole("button", { name: "退出并清除会话" }));

    expect(logout).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "退出 RAM 登录" })).not.toBeInTheDocument(),
    );
  });

  it("keeps the confirmation usable when session cleanup fails", async () => {
    const user = userEvent.setup();
    const { logout } = installApi(populatedSnapshot());
    logout.mockRejectedValueOnce(new Error("cleanup failed"));
    render(<App />);

    await selectNativeMenu("logout");
    const dialog = screen.getByRole("dialog", { name: "退出 RAM 登录" });
    const confirm = within(dialog).getByRole("button", { name: "退出并清除会话" });
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    await user.click(confirm);

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("退出登录未完成，部分会话数据可能已清除，请重试");
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(dialog).toBeInTheDocument();
  });
});
