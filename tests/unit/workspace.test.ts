import { afterEach, describe, expect, it, vi } from "vitest";
import type { SnapshotStore } from "../../src/main/modules/workspace/persistence";
import { Workspace } from "../../src/main/modules/workspace/workspace";
import {
  MAX_RECENT_VISITS,
  createDefaultSnapshot,
  type Favorite,
  type ProductRegionIds,
  type RecentVisit,
  type WorkspaceSnapshot,
  type WorkspaceTab,
} from "../../src/shared/model";
import { CONSOLE_HOME_URL } from "../../src/shared/console-url";

const SLS_TEST_QUERY_URL = "https://sls.console.aliyun.com/lognext/project/example-project/logsearch/sample-app?slsRegion=cn-beijing";

afterEach(() => vi.useRealTimers());

function createTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    product: "ack",
    regionId: "cn-beijing",
    url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
    title: "ACK",
    createdAt: 100,
    lastActiveAt: 100,
    pinned: false,
    taskStatus: null,
    loadState: "deferred",
    canGoBack: false,
    canGoForward: false,
    ...overrides,
  };
}

function createRecentVisit(overrides: Partial<RecentVisit> = {}): RecentVisit {
  return {
    product: "ack",
    regionId: "cn-beijing",
    url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
    title: "北京集群",
    visitedAt: 100,
    ...overrides,
  };
}

function createFavorite(overrides: Partial<Favorite> = {}): Favorite {
  return {
    id: "favorite-1",
    name: "北京集群",
    product: "ack",
    regionId: "cn-beijing",
    url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
    createdAt: 100,
    ...overrides,
  };
}

function productRegionIds(overrides: Partial<ProductRegionIds> = {}): ProductRegionIds {
  return {
    ...createDefaultSnapshot().productRegionIds,
    ...overrides,
  };
}

function createHarness(initialSnapshot: WorkspaceSnapshot = createDefaultSnapshot()) {
  let nextId = 0;
  let currentTime = 1_000;
  const load = vi.fn(async (): Promise<WorkspaceSnapshot> =>
    structuredClone(initialSnapshot),
  );
  const save = vi.fn(async (_snapshot: WorkspaceSnapshot): Promise<void> => undefined);
  const store: SnapshotStore = { load, save };
  const now = vi.fn(() => {
    currentTime += 10;
    return currentTime;
  });
  const id = vi.fn(() => `generated-${++nextId}`);
  // Tests inspect state explicitly; production command responses contain only acknowledgement/error.
  class ObservedWorkspace extends Workspace {
    override async dispatch(...args: Parameters<Workspace["dispatch"]>) {
      return { ...await super.dispatch(...args), snapshot: this.getSnapshot() };
    }
    override async openExternalUrl(...args: Parameters<Workspace["openExternalUrl"]>) {
      return { ...await super.openExternalUrl(...args), snapshot: this.getSnapshot() };
    }
  }
  const workspace = new ObservedWorkspace({ store, now, id });

  return { workspace, load, save, now, id };
}

function createDeferredSave() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Workspace.restore", () => {
  it("scrubs authentication URLs from protocol persistence, closed tabs and legacy files", async () => {
    const authUrl = "https://signin.aliyun.com/login.htm?code=sensitive-callback&state=private-state";
    const { workspace, save } = createHarness();
    await workspace.restore();
    expect((await workspace.openExternalUrl(`clouddock://open?url=${encodeURIComponent(authUrl)}`)).ok).toBe(true);
    const active = workspace.getSnapshot().tabs[0];
    expect(active).toMatchObject({ url: authUrl, isAuthenticating: true });
    expect(JSON.stringify(save.mock.calls.at(-1)![0])).not.toContain("sensitive-callback");
    expect(save.mock.calls.at(-1)![0].tabs[0].url).toBe(CONSOLE_HOME_URL);
    await workspace.dispatch({ type: "close-tab", tabId: active.id });
    expect(workspace.getSnapshot().recentlyClosedTabs[0].url).toBe(CONSOLE_HOME_URL);

    const legacy = { ...createDefaultSnapshot(), tabs: [active], activeTabId: active.id, recentlyClosedTabs: [active] };
    const restored = createHarness(legacy);
    expect((await restored.workspace.restore()).tabs[0].url).toBe(CONSOLE_HOME_URL);
    expect(restored.save).toHaveBeenCalledOnce();
    expect(JSON.stringify(restored.save.mock.calls[0][0])).not.toContain("sensitive-callback");
  });

  it("creates distinct form popup tabs and registers their request before activation", async () => {
    const { workspace } = createHarness();
    await workspace.restore();
    const target = { product: "codeup" as const, regionId: null, url: "https://codeup.aliyun.com/submit" };
    const registered = new Set<string>();
    const unsubscribe = workspace.subscribe((snapshot) => {
      if (snapshot.activeTabId) expect(registered.has(snapshot.activeTabId)).toBe(true);
    });
    await workspace.openConsolePopup(target, (id) => registered.add(id));
    await workspace.openConsolePopup(target, (id) => registered.add(id));
    expect(workspace.getSnapshot().tabs).toHaveLength(2);
    expect(registered.size).toBe(2);
    unsubscribe();
  });
  it("restores durable state while resetting every open tab to a deferred runtime state", async () => {
    const active = createTab({
      id: "active",
      loadState: "ready",
      canGoBack: true,
      canGoForward: true,
      errorMessage: "stale renderer error",
    });
    const crashed = createTab({
      id: "crashed",
      url: "https://cs.console.aliyun.com/#/k8s/deployment?region=cn-beijing",
      loadState: "crashed",
      canGoBack: true,
      errorMessage: "renderer crashed",
    });
    const recentlyClosed = createTab({
      id: "closed",
      loadState: "error",
      errorMessage: "closed error",
    });
    const persisted: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      tabs: [active, crashed],
      activeTabId: active.id,
      recentlyClosedTabs: [recentlyClosed],
      onboardingComplete: true,
      sidebarCollapsed: true,
      notice: null,
    };
    const { workspace, load, save } = createHarness(persisted);

    const restored = await workspace.restore();

    expect(load).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(restored).toMatchObject({
      activeTabId: "active",
      onboardingComplete: true,
      sidebarCollapsed: true,
      notice: null,
    });
    expect(restored.tabs).toEqual([
      expect.objectContaining({
        id: "active",
        loadState: "deferred",
        canGoBack: false,
        canGoForward: false,
        errorMessage: undefined,
      }),
      expect.objectContaining({
        id: "crashed",
        loadState: "deferred",
        canGoBack: false,
        canGoForward: false,
        errorMessage: undefined,
      }),
    ]);
    expect(restored.recentlyClosedTabs).toEqual([
      { ...recentlyClosed, isAuthenticating: false, externalHostname: undefined },
    ]);

    restored.tabs[0].title = "mutated outside";
    expect(workspace.getSnapshot().tabs[0].title).toBe("ACK");
  });

  it("filters unsafe restored tabs, closed tabs, and favorites before publishing state", async () => {
    const safe = createTab({ id: "safe" });
    const unsafe = createTab({ id: "unsafe", url: "data:text/html,untrusted" });
    const external = createTab({ id: "external", url: "https://idp.example.com/sso/continue" });
    const persisted: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      tabs: [unsafe, external, safe],
      activeTabId: unsafe.id,
      recentlyClosedTabs: [unsafe, external],
      favorites: [
        createFavorite({ url: "https://help.aliyun.com/document_detail/1.html" }),
        createFavorite({ id: "external-favorite", url: "https://idp.example.com/sso/continue" }),
      ],
      recentVisits: [
        createRecentVisit(),
        createRecentVisit({ url: "https://idp.example.com/sso/continue", visitedAt: 90 }),
        createRecentVisit({ product: "kafka", visitedAt: 80 }),
      ],
      onboardingComplete: true,
    };
    const { workspace } = createHarness(persisted);

    const restored = await workspace.restore();

    expect(restored.tabs.map((tab) => tab.id)).toEqual(["safe"]);
    expect(restored.activeTabId).toBe("safe");
    expect(restored.recentlyClosedTabs).toEqual([]);
    expect(restored.favorites).toEqual([]);
    expect(restored.recentVisits).toEqual([createRecentVisit()]);
    expect(restored.notice).toBe("已忽略无法安全恢复的页面");
  });

  it("preserves a recovery notice returned by the snapshot store", async () => {
    const persisted = {
      ...createDefaultSnapshot(),
      notice: "工作区数据损坏，已备份原文件并恢复默认设置",
    };
    const { workspace } = createHarness(persisted);

    const restored = await workspace.restore();

    expect(restored.notice).toBe(persisted.notice);
  });

  it("replaces persisted authentication pages with stable console entry URLs", async () => {
    const authTab = createTab({
      id: "auth",
      product: "kafka",
      regionId: "cn-shanghai",
      url: "https://signin.aliyun.com/example.onaliyun.com/login.htm?callback=https%3A%2F%2Fkafka.console.aliyun.com%2Fregion%2Fcn-shanghai%2Finstances#/main",
      title: "阿里云-RAM用户登录",
      loadState: "ready",
    });
    const persisted: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      tabs: [authTab],
      activeTabId: authTab.id,
      recentlyClosedTabs: [authTab],
      onboardingComplete: true,
    };
    const { workspace } = createHarness(persisted);

    const restored = await workspace.restore();

    expect(restored.tabs[0]).toMatchObject({
      url: "https://kafka.console.aliyun.com/region/cn-shanghai/instances",
      loadState: "deferred",
    });
    expect(restored.recentlyClosedTabs[0].url).toBe(
      "https://kafka.console.aliyun.com/region/cn-shanghai/instances",
    );
  });

  it("restores an authenticating DMS tab to its stable non-regional entry", async () => {
    const authTab = createTab({
      id: "dms-auth",
      product: "dms",
      regionId: null,
      url: "https://account.aliyun.com/login/login.htm?oauth_callback=https%3A%2F%2Fdms.aliyun.com%2F",
      title: "阿里云登录页",
    });
    const persisted: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      tabs: [authTab],
      activeTabId: authTab.id,
      onboardingComplete: true,
    };
    const { workspace } = createHarness(persisted);

    const restored = await workspace.restore();

    expect(restored.tabs[0]).toMatchObject({
      product: "dms",
      regionId: null,
      url: "https://dms.aliyun.com/",
      loadState: "deferred",
    });
  });

  it("restores an authenticating Codeup tab to its stable non-regional entry", async () => {
    const authTab = createTab({
      id: "codeup-auth",
      product: "codeup",
      regionId: null,
      url: "https://account-devops.aliyun.com/login?callback=https%3A%2F%2Fcodeup.aliyun.com%2F",
      title: "阿里云登录页",
    });
    const persisted: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      tabs: [authTab],
      activeTabId: authTab.id,
      onboardingComplete: true,
    };
    const { workspace } = createHarness(persisted);

    const restored = await workspace.restore();

    expect(restored.tabs[0]).toMatchObject({
      product: "codeup",
      regionId: null,
      url: "https://codeup.aliyun.com/",
      loadState: "deferred",
    });
  });

  it("restores Flow pipeline tabs, recently closed tabs, and favorites as Codeup state", async () => {
    const flowUrl = "https://flow.aliyun.com/pipelines/123";
    const flowTab = createTab({
      id: "flow",
      product: "codeup",
      regionId: null,
      url: flowUrl,
      title: "Deploy pipeline",
    });
    const persisted: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      tabs: [flowTab],
      activeTabId: flowTab.id,
      recentlyClosedTabs: [{ ...flowTab, id: "closed-flow" }],
      favorites: [createFavorite({ product: "codeup", regionId: null, url: flowUrl })],
      onboardingComplete: true,
    };
    const { workspace } = createHarness(persisted);

    const restored = await workspace.restore();

    expect(restored.tabs[0]).toMatchObject({ product: "codeup", regionId: null, url: flowUrl });
    expect(restored.recentlyClosedTabs[0]).toMatchObject({
      product: "codeup",
      regionId: null,
      url: flowUrl,
    });
    expect(restored.favorites[0]).toMatchObject({
      product: "codeup",
      regionId: null,
      url: flowUrl,
    });
  });

  it("restores an authenticating SLS tab to its stable profile entry", async () => {
    const authTab = createTab({
      id: "sls-auth",
      product: "sls",
      regionId: null,
      url: "https://account.aliyun.com/login/login.htm?oauth_callback=https%3A%2F%2Fsls.console.aliyun.com%2Flognext%2Fprofile",
      title: "阿里云登录页",
    });
    const persisted: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      tabs: [authTab],
      activeTabId: authTab.id,
      onboardingComplete: true,
    };
    const { workspace } = createHarness(persisted);

    const restored = await workspace.restore();

    expect(restored.tabs[0]).toMatchObject({
      product: "sls",
      regionId: null,
      url: "https://sls.console.aliyun.com/lognext/profile",
      loadState: "deferred",
    });
  });
});

describe("Workspace.subscribe", () => {
  it("coalesces runtime updates but immediately publishes activation and cancels stale broadcasts", async () => {
    vi.useFakeTimers();
    const first = createTab();
    const second = createTab({ id: "second" });
    const workspace = new Workspace({ store: {
      load: async () => ({ ...createDefaultSnapshot(), tabs: [first, second], activeTabId: first.id }),
      save: async () => {},
    } });
    await workspace.restore();
    const listener = vi.fn();
    const unsubscribe = workspace.subscribe(listener);
    listener.mockClear();
    for (let i = 0; i < 100; i++) {
      const result = await workspace.dispatch({ type: "update-tab", tabId: first.id, loadState: i % 2 ? "ready" : "loading" });
      expect(result).toEqual({ ok: true });
    }
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].tabs[0].loadState).toBe("ready");
    await workspace.dispatch({ type: "update-tab", tabId: first.id, loadState: "loading" });
    await workspace.dispatch({ type: "activate-tab", tabId: second.id });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1][0].activeTabId).toBe(second.id);
    await vi.advanceTimersByTimeAsync(16);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("publishes an immediate clone, emits changed snapshots, and stops after unsubscribe", async () => {
    const { workspace, save } = createHarness();
    const snapshots: WorkspaceSnapshot[] = [];
    const listener = vi.fn((snapshot: WorkspaceSnapshot) => snapshots.push(snapshot));

    const unsubscribe = workspace.subscribe(listener);
    expect(listener).toHaveBeenCalledOnce();
    snapshots[0].notice = "listener mutation";
    expect(workspace.getSnapshot().notice).toBeNull();

    await workspace.dispatch({ type: "set-notice", notice: "saved notice" });
    await workspace.dispatch({ type: "set-notice", notice: "saved notice" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(snapshots[1].notice).toBe("saved notice");
    expect(save).not.toHaveBeenCalled();

    unsubscribe();
    await workspace.dispatch({ type: "set-sidebar-collapsed", collapsed: true });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("broadcasts runtime tab changes without persisting them", async () => {
    const tab = createTab();
    const initial = {
      ...createDefaultSnapshot(),
      tabs: [tab],
      activeTabId: tab.id,
      onboardingComplete: true,
    };
    const { workspace, save } = createHarness(initial);
    await workspace.restore();
    const listener = vi.fn();
    workspace.subscribe(listener);

    const result = await workspace.dispatch({
      type: "update-tab",
      tabId: tab.id,
      loadState: "loading",
      canGoBack: true,
      canGoForward: true,
      errorMessage: "transient",
    });

    expect(result.snapshot.tabs[0]).toMatchObject({
      loadState: "loading",
      canGoBack: true,
      canGoForward: true,
    });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(save).not.toHaveBeenCalled();
  });

  it("persists durable tab changes with runtime fields reset", async () => {
    const tab = createTab({ loadState: "ready", canGoBack: true, canGoForward: true });
    const initial = {
      ...createDefaultSnapshot(),
      tabs: [tab],
      activeTabId: tab.id,
      onboardingComplete: true,
    };
    const { workspace, save } = createHarness(initial);
    await workspace.restore();

    const result = await workspace.dispatch({
      type: "update-tab",
      tabId: tab.id,
      title: "工作负载",
      loadState: "ready",
      canGoBack: true,
    });

    expect(result.snapshot.tabs[0]).toMatchObject({
      title: "工作负载",
      loadState: "ready",
      canGoBack: true,
    });
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].tabs[0]).toMatchObject({
      title: "工作负载",
      loadState: "deferred",
      canGoBack: false,
      canGoForward: false,
      isAuthenticating: false,
    });
    expect(save.mock.calls[0][0].tabs[0].errorMessage).toBeUndefined();
  });
});

describe("Workspace onboarding and entry tabs", () => {
  it("completes onboarding with unique regions and opens the requested initial product", async () => {
    const { workspace, save } = createHarness();

    const result = await workspace.dispatch({
      type: "complete-onboarding",
      selectedProducts: ["kafka", "dms", "kafka"],
      productRegionIds: productRegionIds({
        kafka: ["cn-shanghai", "cn-beijing", "cn-shanghai"],
      }),
      initialProduct: "kafka",
    });

    expect(result.ok).toBe(true);
    expect(result.snapshot).toMatchObject({
      onboardingComplete: true,
      selectedProducts: ["kafka", "dms"],
      productRegionIds: productRegionIds({
        kafka: ["cn-shanghai", "cn-beijing"],
      }),
      activeTabId: "generated-1",
      notice: null,
    });
    expect(result.snapshot.tabs).toEqual([
      expect.objectContaining({
        id: "generated-1",
        product: "kafka",
        regionId: "cn-shanghai",
        title: "Kafka",
        url: "https://kafka.console.aliyun.com/region/cn-shanghai/instances",
        loadState: "deferred",
      }),
    ]);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenLastCalledWith(result.snapshot);
  });

  it("rejects unavailable onboarding regions without changing or persisting state", async () => {
    const { workspace, save } = createHarness();

    const result = await workspace.dispatch({
      type: "complete-onboarding",
      selectedProducts: ["ack"],
      productRegionIds: productRegionIds({ ack: ["cn-unknown"] }),
      initialProduct: "ack",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "请选择有效地域",
      snapshot: createDefaultSnapshot(),
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("can start with the single non-regional DMS entry", async () => {
    const { workspace, save } = createHarness();

    const result = await workspace.dispatch({
      type: "complete-onboarding",
      selectedProducts: ["dms"],
      productRegionIds: productRegionIds(),
      initialProduct: "dms",
    });

    expect(result.ok).toBe(true);
    expect(result.snapshot.tabs).toEqual([
      expect.objectContaining({
        product: "dms",
        regionId: null,
        title: "DMS",
        url: "https://dms.aliyun.com/",
      }),
    ]);
    expect(save).toHaveBeenCalledOnce();
  });

  it("can start with the single non-regional Codeup entry", async () => {
    const { workspace, save } = createHarness();

    const result = await workspace.dispatch({
      type: "complete-onboarding",
      selectedProducts: ["codeup"],
      productRegionIds: productRegionIds(),
      initialProduct: "codeup",
    });

    expect(result.ok).toBe(true);
    expect(result.snapshot.tabs).toEqual([
      expect.objectContaining({
        product: "codeup",
        regionId: null,
        title: "Codeup",
        url: "https://codeup.aliyun.com/",
      }),
    ]);
    expect(save).toHaveBeenCalledOnce();
  });

  it("can start with the non-regional SLS profile entry", async () => {
    const { workspace, save } = createHarness();

    const result = await workspace.dispatch({
      type: "complete-onboarding",
      selectedProducts: ["sls"],
      productRegionIds: productRegionIds(),
      initialProduct: "sls",
    });

    expect(result.ok).toBe(true);
    expect(result.snapshot.tabs).toEqual([
      expect.objectContaining({
        product: "sls",
        regionId: null,
        title: "SLS",
        url: "https://sls.console.aliyun.com/lognext/profile",
      }),
    ]);
    expect(save).toHaveBeenCalledOnce();
  });

  it("starts MSE only in Beijing or Shanghai and requires the initial module to be selected", async () => {
    const { workspace, save } = createHarness();

    const unsupportedRegion = await workspace.dispatch({
      type: "complete-onboarding",
      selectedProducts: ["mse"],
      productRegionIds: productRegionIds({ mse: [] }),
      initialProduct: "mse",
    });
    expect(unsupportedRegion).toMatchObject({
      ok: false,
      error: "MSE 仅支持北京和上海，请至少选择其中一个地域",
    });

    const unselectedInitial = await workspace.dispatch({
      type: "complete-onboarding",
      selectedProducts: ["ack"],
      productRegionIds: productRegionIds(),
      initialProduct: "mse",
    });
    expect(unselectedInitial).toMatchObject({
      ok: false,
      error: "首次打开的产品必须属于已选模块",
    });

    const result = await workspace.dispatch({
      type: "complete-onboarding",
      selectedProducts: ["mse", "ack"],
      productRegionIds: productRegionIds({
        ack: ["cn-hangzhou"],
        mse: ["cn-shanghai"],
      }),
      initialProduct: "mse",
    });
    expect(result.snapshot.tabs).toEqual([
      expect.objectContaining({
        product: "mse",
        regionId: "cn-shanghai",
        title: "MSE",
        url: "https://mse.console.aliyun.com/#/InstanceList?region=cn-shanghai",
      }),
    ]);
    expect(save).toHaveBeenCalledOnce();
  });

  it("deduplicates identical product-region entries and avoids redundant persistence", async () => {
    const { workspace, save } = createHarness();

    const first = await workspace.dispatch({
      type: "open-entry",
      product: "ack",
      regionId: "cn-beijing",
    });
    const second = await workspace.dispatch({
      type: "open-entry",
      product: "ack",
      regionId: "cn-beijing",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.snapshot.tabs).toHaveLength(1);
    expect(second.snapshot.activeTabId).toBe("generated-1");
    expect(save).toHaveBeenCalledOnce();
  });

  it.each([
    {
      product: "ack" as const,
      regionId: "cn-beijing",
      detailsUrl: "https://cs.console.aliyun.com/#/k8s/deployment?region=cn-beijing",
    },
    {
      product: "kafka" as const,
      regionId: "cn-shanghai",
      detailsUrl: "https://kafka.console.aliyun.com/region/cn-shanghai/consumer-groups",
    },
    {
      product: "mse" as const,
      regionId: "cn-beijing",
      detailsUrl: "https://mse.console.aliyun.com/#/ServiceList?region=cn-beijing",
    },
  ])("reuses the current $product region tab without resetting its navigated URL", async ({
    product,
    regionId,
    detailsUrl,
  }) => {
    const { workspace } = createHarness();

    await workspace.dispatch({ type: "open-entry", product, regionId });
    await workspace.dispatch({
      type: "update-tab",
      tabId: "generated-1",
      url: detailsUrl,
    });
    const reopened = await workspace.dispatch({ type: "open-entry", product, regionId });

    expect(reopened.ok).toBe(true);
    expect(reopened.snapshot.tabs).toHaveLength(1);
    expect(reopened.snapshot.activeTabId).toBe("generated-1");
    expect(reopened.snapshot.tabs[0].url).toBe(detailsUrl);
  });

  it("keeps regional entry reuse isolated by region", async () => {
    const { workspace } = createHarness();
    const beijingDetails =
      "https://cs.console.aliyun.com/#/k8s/deployment?region=cn-beijing";

    await workspace.dispatch({
      type: "open-entry",
      product: "ack",
      regionId: "cn-beijing",
    });
    await workspace.dispatch({
      type: "update-tab",
      tabId: "generated-1",
      url: beijingDetails,
    });
    const shanghai = await workspace.dispatch({
      type: "open-entry",
      product: "ack",
      regionId: "cn-shanghai",
    });

    expect(shanghai.ok).toBe(true);
    expect(shanghai.snapshot.tabs).toHaveLength(2);
    expect(shanghai.snapshot.activeTabId).toBe("generated-2");
    expect(shanghai.snapshot.tabs[0].url).toBe(beijingDetails);
    expect(shanghai.snapshot.tabs[1]).toMatchObject({
      product: "ack",
      regionId: "cn-shanghai",
      url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-shanghai",
    });
  });

  it("activates the most recently used tab for the requested product and region", async () => {
    const older = createTab({
      id: "ack-beijing-older",
      url: "https://cs.console.aliyun.com/#/k8s/deployment?region=cn-beijing",
      lastActiveAt: 200,
    });
    const recent = createTab({
      id: "ack-beijing-recent",
      url: "https://cs.console.aliyun.com/#/k8s/service?region=cn-beijing",
      lastActiveAt: 300,
    });
    const shanghai = createTab({
      id: "ack-shanghai-newer",
      regionId: "cn-shanghai",
      url: "https://cs.console.aliyun.com/#/k8s/deployment?region=cn-shanghai",
      lastActiveAt: 400,
    });
    const kafka = createTab({
      id: "kafka-active",
      product: "kafka",
      regionId: "cn-shanghai",
      url: "https://kafka.console.aliyun.com/region/cn-shanghai/instances",
      lastActiveAt: 500,
    });
    const initial: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      tabs: [older, recent, shanghai, kafka],
      activeTabId: kafka.id,
    };
    const { workspace } = createHarness(initial);
    await workspace.restore();

    const reopened = await workspace.dispatch({
      type: "open-entry",
      product: "ack",
      regionId: "cn-beijing",
    });

    expect(reopened.ok).toBe(true);
    expect(reopened.snapshot.tabs).toHaveLength(4);
    expect(reopened.snapshot.activeTabId).toBe(recent.id);
    expect(reopened.snapshot.tabs.find((tab) => tab.id === recent.id)?.url).toBe(recent.url);
  });

  it("opens the fixed console home without selecting a product entry", async () => {
    const { workspace } = createHarness();

    const first = await workspace.dispatch({ type: "open-console-home" });
    const second = await workspace.dispatch({ type: "open-console-home" });

    expect(first.snapshot.tabs).toEqual([
      expect.objectContaining({
        product: "aliyun",
        regionId: null,
        url: CONSOLE_HOME_URL,
        title: "控制台首页",
      }),
    ]);
    expect(second.snapshot.tabs).toHaveLength(1);
    expect(second.snapshot.activeTabId).toBe(first.snapshot.activeTabId);
  });

  it("opens pasted console URLs in a deduplicated product tab", async () => {
    const { workspace } = createHarness();

    const flow = await workspace.dispatch({
      type: "open-pasted-url",
      url: "https://flow.aliyun.com/pipelines/123?spm=from-chat",
    });
    const duplicate = await workspace.dispatch({
      type: "open-pasted-url",
      url: "https://flow.aliyun.com/pipelines/123",
    });
    const home = await workspace.dispatch({
      type: "open-pasted-url",
      url: CONSOLE_HOME_URL,
    });
    const rejected = await workspace.dispatch({
      type: "open-pasted-url",
      url: "https://example.com/untrusted",
    });

    expect(flow.snapshot.tabs).toEqual([
      expect.objectContaining({
        product: "codeup",
        regionId: null,
        url: "https://flow.aliyun.com/pipelines/123?spm=from-chat",
      }),
    ]);
    expect(duplicate.snapshot.tabs).toHaveLength(1);
    expect(home.snapshot.tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: CONSOLE_HOME_URL, title: "控制台首页" }),
    ]));
    expect(rejected).toMatchObject({ ok: false, error: "仅支持已接入的阿里云控制台链接" });
  });

  it("opens a validated URL batch atomically and deduplicates normalized targets", async () => {
    const { workspace, save, id } = createHarness();

    const result = await workspace.dispatch({
      type: "open-pasted-urls",
      urls: [
        "https://flow.aliyun.com/pipelines/123?spm=first",
        "https://flow.aliyun.com/pipelines/123?source=duplicate",
        "http://ecs.console.aliyun.com/ecs/home",
        CONSOLE_HOME_URL,
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.snapshot.tabs).toEqual([
      expect.objectContaining({
        product: "codeup",
        url: "https://flow.aliyun.com/pipelines/123?spm=first",
      }),
      expect.objectContaining({
        product: "aliyun",
        url: "https://ecs.console.aliyun.com/ecs/home",
      }),
      expect.objectContaining({
        product: "aliyun",
        url: CONSOLE_HOME_URL,
        title: "控制台首页",
      }),
    ]);
    expect(result.snapshot.activeTabId).toBe("generated-3");
    expect(id).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenCalledOnce();
  });

  it("does not change state when any pasted URL is unsupported", async () => {
    const { workspace, save, id } = createHarness();
    const before = workspace.getSnapshot();

    const result = await workspace.dispatch({
      type: "open-pasted-urls",
      urls: [
        "https://flow.aliyun.com/pipelines/valid",
        "https://example.com/not-supported",
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      error: "仅支持已接入的阿里云控制台链接",
      snapshot: before,
    });
    expect(id).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("rejects pasted URL batches outside the 1..10 boundary", async () => {
    const { workspace, save } = createHarness();
    const eleven = Array.from(
      { length: 11 },
      (_, index) => `https://oss.console.aliyun.com/bucket/${index}`,
    );

    await expect(workspace.dispatch({ type: "open-pasted-urls", urls: [] }))
      .resolves.toMatchObject({ ok: false, error: "操作参数无效" });
    await expect(workspace.dispatch({ type: "open-pasted-urls", urls: eleven }))
      .resolves.toMatchObject({ ok: false, error: "操作参数无效" });
    expect(save).not.toHaveBeenCalled();
  });

  it("persists tab filters together and skips an unchanged update", async () => {
    const { workspace, save } = createHarness();

    const changed = await workspace.dispatch({
      type: "set-tab-filters",
      productFilter: "aliyun",
      taskFilter: "doing",
    });
    const unchanged = await workspace.dispatch({
      type: "set-tab-filters",
      productFilter: "aliyun",
      taskFilter: "doing",
    });

    expect(changed.snapshot).toMatchObject({
      productFilter: "aliyun",
      taskFilter: "doing",
    });
    expect(unchanged.ok).toBe(true);
    expect(save).toHaveBeenCalledOnce();
  });

  it("deduplicates the DMS entry and rejects invalid product-region combinations", async () => {
    const { workspace, save } = createHarness();

    const first = await workspace.dispatch({
      type: "open-entry",
      product: "dms",
      regionId: null,
    });
    const second = await workspace.dispatch({
      type: "open-url",
      product: "dms",
      regionId: null,
      url: "https://dms.aliyun.com/?spm=second",
    });
    const regionalDms = await workspace.dispatch({
      type: "open-entry",
      product: "dms",
      regionId: "cn-beijing",
    });
    const regionlessAck = await workspace.dispatch({
      type: "open-entry",
      product: "ack",
      regionId: null,
    });
    const mismatchedUrl = await workspace.dispatch({
      type: "open-url",
      product: "dms",
      regionId: null,
      url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.snapshot.tabs).toHaveLength(1);
    expect(regionalDms).toMatchObject({ ok: false, error: "DMS 不使用地域" });
    expect(regionlessAck).toMatchObject({ ok: false, error: "ACK 在该地域不可用" });
    expect(mismatchedUrl).toMatchObject({
      ok: false,
      error: "控制台链接与产品或地域不匹配",
    });
    expect(save).toHaveBeenCalledOnce();
  });

  it("deduplicates the Codeup entry and rejects invalid product-region combinations", async () => {
    const { workspace, save } = createHarness();

    const first = await workspace.dispatch({
      type: "open-entry",
      product: "codeup",
      regionId: null,
    });
    const second = await workspace.dispatch({
      type: "open-url",
      product: "codeup",
      regionId: null,
      url: "https://codeup.aliyun.com/?spm=second",
    });
    const regionalCodeup = await workspace.dispatch({
      type: "open-entry",
      product: "codeup",
      regionId: "cn-beijing",
    });
    const mismatchedUrl = await workspace.dispatch({
      type: "open-url",
      product: "codeup",
      regionId: null,
      url: "https://dms.aliyun.com/",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.snapshot.tabs).toHaveLength(1);
    expect(regionalCodeup).toMatchObject({ ok: false, error: "Codeup 不使用地域" });
    expect(mismatchedUrl).toMatchObject({
      ok: false,
      error: "控制台链接与产品或地域不匹配",
    });
    expect(save).toHaveBeenCalledOnce();
  });

  it("reuses the current Codeup tab without resetting its navigated URL", async () => {
    const { workspace } = createHarness();
    const detailsUrl = "https://codeup.aliyun.com/org/project/repo/blob/main/README.md";

    await workspace.dispatch({
      type: "open-entry",
      product: "codeup",
      regionId: null,
    });
    await workspace.dispatch({
      type: "update-tab",
      tabId: "generated-1",
      url: detailsUrl,
    });
    const reopened = await workspace.dispatch({
      type: "open-entry",
      product: "codeup",
      regionId: null,
    });

    expect(reopened.ok).toBe(true);
    expect(reopened.snapshot.tabs).toHaveLength(1);
    expect(reopened.snapshot.activeTabId).toBe("generated-1");
    expect(reopened.snapshot.tabs[0].url).toBe(detailsUrl);
  });

  it("activates the most recently used Codeup tab when another product is active", async () => {
    const older = createTab({
      id: "codeup-older",
      product: "codeup",
      regionId: null,
      url: "https://codeup.aliyun.com/org/older-project",
      title: "Older project",
      lastActiveAt: 200,
    });
    const recent = createTab({
      id: "codeup-recent",
      product: "codeup",
      regionId: null,
      url: "https://flow.aliyun.com/pipelines/recent",
      title: "Recent pipeline",
      lastActiveAt: 300,
    });
    const dms = createTab({
      id: "dms-active",
      product: "dms",
      regionId: null,
      url: "https://dms.aliyun.com/",
      title: "DMS",
      lastActiveAt: 400,
    });
    const initial: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      tabs: [older, recent, dms],
      activeTabId: dms.id,
    };
    const { workspace } = createHarness(initial);
    await workspace.restore();

    const reopened = await workspace.dispatch({
      type: "open-entry",
      product: "codeup",
      regionId: null,
    });

    expect(reopened.ok).toBe(true);
    expect(reopened.snapshot.tabs).toHaveLength(3);
    expect(reopened.snapshot.activeTabId).toBe(recent.id);
    expect(reopened.snapshot.tabs.find((tab) => tab.id === recent.id)?.url).toBe(recent.url);
  });

  it("opens the SLS profile and custom log query as distinct regionless tabs", async () => {
    const { workspace, save } = createHarness();

    const profile = await workspace.dispatch({
      type: "open-entry",
      product: "sls",
      regionId: null,
    });
    const query = await workspace.dispatch({
      type: "open-url",
      product: "sls",
      regionId: null,
      url: SLS_TEST_QUERY_URL,
      title: "示例应用日志",
    });
    const duplicateQuery = await workspace.dispatch({
      type: "open-url",
      product: "sls",
      regionId: null,
      url: `${SLS_TEST_QUERY_URL}&source=nav`,
      title: "重复查询",
    });
    const regionalSls = await workspace.dispatch({
      type: "open-entry",
      product: "sls",
      regionId: "cn-beijing",
    });

    expect(profile.ok).toBe(true);
    expect(query.ok).toBe(true);
    expect(query.snapshot.tabs).toHaveLength(2);
    expect(query.snapshot.tabs[1]).toMatchObject({
      product: "sls",
      regionId: null,
      url: SLS_TEST_QUERY_URL,
      title: "示例应用日志",
    });
    expect(duplicateQuery.snapshot.tabs).toHaveLength(2);
    expect(regionalSls).toMatchObject({ ok: false, error: "SLS 不使用地域" });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("opens MSE only in its supported regions", async () => {
    const { workspace, save } = createHarness();

    const beijing = await workspace.dispatch({
      type: "open-entry",
      product: "mse",
      regionId: "cn-beijing",
    });
    const hangzhou = await workspace.dispatch({
      type: "open-entry",
      product: "mse",
      regionId: "cn-hangzhou",
    });

    expect(beijing.snapshot.tabs).toEqual([
      expect.objectContaining({
        product: "mse",
        regionId: "cn-beijing",
        url: "https://mse.console.aliyun.com/#/InstanceList?region=cn-beijing",
      }),
    ]);
    expect(hangzhou).toMatchObject({ ok: false, error: "MSE 在该地域不可用" });
    expect(save).toHaveBeenCalledOnce();
  });

  it("uses normalized URLs for dedupe while preserving the first original URL", async () => {
    const { workspace, save } = createHarness();
    const original =
      "https://cs.console.aliyun.com/#/k8s/deployment?region=cn-beijing&spm=first";
    const equivalent =
      "https://cs.console.aliyun.com/#/k8s/deployment?spm=second&region=cn-beijing";

    await workspace.dispatch({
      type: "open-url",
      product: "ack",
      regionId: "cn-beijing",
      url: original,
      title: "  生产工作负载  ",
    });
    await workspace.dispatch({
      type: "open-entry",
      product: "kafka",
      regionId: "cn-shanghai",
    });
    const result = await workspace.dispatch({
      type: "open-url",
      product: "ack",
      regionId: "cn-beijing",
      url: equivalent,
      title: "should not replace",
    });

    expect(result.ok).toBe(true);
    expect(result.snapshot.tabs).toHaveLength(2);
    expect(result.snapshot.activeTabId).toBe("generated-1");
    expect(result.snapshot.tabs[0]).toMatchObject({
      url: original,
      title: "生产工作负载",
    });
    expect(save).toHaveBeenCalledTimes(3);
  });
});

describe("Workspace external deep links", () => {
  it("restores explicitly allowed external tabs and rejects them after the allowlist is removed", async () => {
    let saved = createDefaultSnapshot();
    const store: SnapshotStore = {
      load: async () => structuredClone(saved),
      save: async (snapshot) => { saved = structuredClone(snapshot); },
    };
    const externalOpenHostRules = [{ kind: "exact" as const, hostname: "docs.example.com" }];
    const workspace = new Workspace({ store, externalOpenHostRules });
    await workspace.restore();
    const result = await workspace.openExternalUrl(externalUrl("https://docs.example.com/runbook"));
    expect(result.ok).toBe(true);
    const restored = await new Workspace({ store, externalOpenHostRules }).restore();
    expect(restored.tabs).toHaveLength(1);
    expect(restored.tabs[0].url).toBe("https://docs.example.com/runbook");
    const revoked = await new Workspace({ store }).restore();
    expect(revoked.tabs).toEqual([]);
    expect(revoked.notice).toContain("已忽略无法安全恢复的页面");
  });

  it("restores default-allowlisted Aliyun pages, including recently closed tabs", async () => {
    const opened = createTab({ product: "aliyun", regionId: null, url: "https://help.aliyun.com/runbook" });
    const { workspace } = createHarness({ ...createDefaultSnapshot(), tabs: [opened], activeTabId: opened.id, recentlyClosedTabs: [{ ...opened, id: "closed" }] });
    const restored = await workspace.restore();
    expect(restored.tabs[0].url).toBe(opened.url);
    expect(restored.recentlyClosedTabs[0].url).toBe(opened.url);
  });

  function externalUrl(target: string): string {
    return `clouddock://open?url=${encodeURIComponent(target)}`;
  }

  it.each([
    "https://signin.aliyun.com/login.htm",
    "https://team.internal.aliyun.com/runbook",
  ])("opens a target only after the complete external deep-link parser accepts it: %s", async (target) => {
    const { workspace, save } = createHarness();

    const result = await workspace.openExternalUrl(externalUrl(target), []);

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        activeTabId: "generated-1",
        tabs: [{ product: "aliyun", regionId: null, url: target }],
      },
    });
    expect(save).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "https://signin.aliyun.com.evil.example/login",
      "目标主机不在白名单：signin.aliyun.com.evil.example",
    ],
    ["http://signin.aliyun.com/login", "外部跳转只允许 HTTPS 目标"],
  ])("rejects an unsafe external target without changing the workspace: %s", async (target, error) => {
    const { workspace, save } = createHarness();

    const result = await workspace.openExternalUrl(externalUrl(target), []);

    expect(result).toMatchObject({ ok: false, error, snapshot: { tabs: [] } });
    expect(save).not.toHaveBeenCalled();
  });

  it("does not weaken the ordinary workspace open-url command", async () => {
    const { workspace, save } = createHarness();

    const result = await workspace.dispatch({
      type: "open-url",
      product: "aliyun",
      regionId: null,
      url: "https://signin.aliyun.com/login.htm",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "只允许打开受信任的阿里云控制台链接",
      snapshot: { tabs: [] },
    });
    expect(save).not.toHaveBeenCalled();
  });
});

describe("Workspace tab ordering", () => {
  it("moves tabs to a durable target index without changing the active tab", async () => {
    const tabs = [
      createTab({ id: "first" }),
      createTab({
        id: "second",
        url: "https://cs.console.aliyun.com/#/k8s/deployment?region=cn-beijing",
      }),
      createTab({
        id: "third",
        url: "https://kafka.console.aliyun.com/region/cn-shanghai/instances",
        product: "kafka",
        regionId: "cn-shanghai",
      }),
    ];
    const initial: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      tabs,
      activeTabId: "second",
      onboardingComplete: true,
    };
    const { workspace, save } = createHarness(initial);
    await workspace.restore();

    const moved = await workspace.dispatch({
      type: "move-tab",
      tabId: "first",
      toIndex: 2,
    });

    expect(moved).toMatchObject({ ok: true });
    expect(moved.snapshot.tabs.map((tab) => tab.id)).toEqual(["second", "third", "first"]);
    expect(moved.snapshot.activeTabId).toBe("second");
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].tabs.map((tab) => tab.id)).toEqual([
      "second",
      "third",
      "first",
    ]);

    const unchanged = await workspace.dispatch({
      type: "move-tab",
      tabId: "first",
      toIndex: 2,
    });
    expect(unchanged.ok).toBe(true);
    expect(save).toHaveBeenCalledOnce();
  });

  it("rejects missing tabs and target indexes outside the current tab list", async () => {
    const tabs = [
      createTab({ id: "first" }),
      createTab({
        id: "second",
        url: "https://cs.console.aliyun.com/#/k8s/deployment?region=cn-beijing",
      }),
    ];
    const initial: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      tabs,
      activeTabId: "first",
      onboardingComplete: true,
    };
    const { workspace, save } = createHarness(initial);
    await workspace.restore();

    const missing = await workspace.dispatch({ type: "move-tab", tabId: "missing", toIndex: 0 });
    const pastEnd = await workspace.dispatch({ type: "move-tab", tabId: "first", toIndex: 2 });
    const negative = await workspace.dispatch({ type: "move-tab", tabId: "first", toIndex: -1 });

    expect(missing).toMatchObject({ ok: false, error: "标签页不存在" });
    expect(pastEnd).toMatchObject({ ok: false, error: "标签目标位置无效" });
    expect(negative).toMatchObject({ ok: false, error: "操作参数无效" });
    expect(workspace.getSnapshot().tabs.map((tab) => tab.id)).toEqual(["first", "second"]);
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps tab product and region synchronized with observed console navigation", async () => {
    const { workspace } = createHarness();
    await workspace.dispatch({
      type: "open-entry",
      product: "ack",
      regionId: "cn-beijing",
    });

    const navigated = await workspace.dispatch({
      type: "update-tab",
      tabId: "generated-1",
      url: "https://kafka.console.aliyun.com/region/cn-shanghai/consumer-groups",
      target: { product: "ack", regionId: "cn-beijing" },
    });
    expect(navigated.snapshot.tabs[0]).toMatchObject({
      product: "kafka",
      regionId: "cn-shanghai",
    });

    const dms = await workspace.dispatch({
      type: "update-tab",
      tabId: "generated-1",
      url: "https://dmsnext.console.aliyun.com/workbench",
    });
    expect(dms.snapshot.tabs[0]).toMatchObject({
      product: "dms",
      regionId: null,
      url: "https://dmsnext.console.aliyun.com/workbench",
    });

    const codeup = await workspace.dispatch({
      type: "update-tab",
      tabId: "generated-1",
      url: "https://flow.aliyun.com/pipelines/123",
    });
    expect(codeup.snapshot.tabs[0]).toMatchObject({
      product: "codeup",
      regionId: null,
      url: "https://flow.aliyun.com/pipelines/123",
    });

    const external = await workspace.dispatch({
      type: "update-tab",
      tabId: "generated-1",
      url: "https://idp.example.com/sso/continue",
    });
    expect(external.snapshot.tabs[0]).toMatchObject({
      product: "codeup",
      regionId: null,
      url: "https://flow.aliyun.com/pipelines/123",
      externalHostname: "idp.example.com",
      isAuthenticating: true,
    });

    const returned = await workspace.dispatch({
      type: "update-tab",
      tabId: "generated-1",
      url: "https://flow.aliyun.com/pipelines/123",
    });
    expect(returned.snapshot.tabs[0]).toMatchObject({
      product: "codeup",
      regionId: null,
      url: "https://flow.aliyun.com/pipelines/123",
      isAuthenticating: false,
    });
    expect(returned.snapshot.tabs[0].externalHostname).toBeUndefined();

    const authenticating = await workspace.dispatch({
      type: "update-tab",
      tabId: "generated-1",
      url: "https://account.aliyun.com/login/login.htm",
      title: "阿里云-RAM用户登录",
    });
    expect(authenticating.snapshot.tabs[0]).toMatchObject({
      product: "codeup",
      regionId: null,
      url: "https://flow.aliyun.com/pipelines/123",
      externalHostname: "account.aliyun.com",
      title: "阿里云-RAM用户登录",
      isAuthenticating: true,
    });
  });

  it("keeps an unrestricted external page out of the durable workspace snapshot", async () => {
    const tab = createTab({ loadState: "ready" });
    const initial = {
      ...createDefaultSnapshot(),
      tabs: [tab],
      activeTabId: tab.id,
      onboardingComplete: true,
    };
    const { workspace, save } = createHarness(initial);
    await workspace.restore();

    const external = await workspace.dispatch({
      type: "update-tab",
      tabId: tab.id,
      url: "https://idp.example.com/sso/continue?token=secret",
    });

    expect(external.snapshot.tabs[0]).toMatchObject({
      url: tab.url,
      externalHostname: "idp.example.com",
      isAuthenticating: true,
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("activates, closes, and reopens tabs with neighbor selection and LIFO closed order", async () => {
    const { workspace } = createHarness();
    const urls = [
      "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
      "https://cs.console.aliyun.com/#/k8s/deployment?region=cn-beijing",
      "https://cs.console.aliyun.com/#/k8s/service?region=cn-beijing",
    ];
    for (const [index, url] of urls.entries()) {
      await workspace.dispatch({
        type: "open-url",
        product: "ack",
        regionId: "cn-beijing",
        url,
        title: `tab ${index + 1}`,
      });
    }

    const activated = await workspace.dispatch({ type: "activate-tab", tabId: "generated-2" });
    expect(activated.snapshot.activeTabId).toBe("generated-2");
    expect(activated.snapshot.tabs[1].lastActiveAt).toBeGreaterThan(
      activated.snapshot.tabs[1].createdAt,
    );

    await workspace.dispatch({
      type: "update-tab",
      tabId: "generated-2",
      loadState: "error",
      canGoBack: true,
      canGoForward: true,
      errorMessage: "load failed",
    });
    const closedMiddle = await workspace.dispatch({ type: "close-tab", tabId: "generated-2" });
    expect(closedMiddle.snapshot.tabs.map((tab) => tab.id)).toEqual([
      "generated-1",
      "generated-3",
    ]);
    expect(closedMiddle.snapshot.activeTabId).toBe("generated-3");
    expect(closedMiddle.snapshot.recentlyClosedTabs[0]).toMatchObject({
      id: "generated-2",
      loadState: "deferred",
      canGoBack: false,
      canGoForward: false,
      errorMessage: undefined,
    });

    const closedLast = await workspace.dispatch({ type: "close-tab", tabId: "generated-3" });
    expect(closedLast.snapshot.activeTabId).toBe("generated-1");
    expect(closedLast.snapshot.recentlyClosedTabs.map((tab) => tab.id)).toEqual([
      "generated-3",
      "generated-2",
    ]);

    const reopenedLast = await workspace.dispatch({ type: "reopen-closed-tab" });
    expect(reopenedLast.snapshot.tabs.map((tab) => tab.id)).toEqual([
      "generated-1",
      "generated-3",
    ]);
    expect(reopenedLast.snapshot.activeTabId).toBe("generated-3");

    const reopenedMiddle = await workspace.dispatch({ type: "reopen-closed-tab" });
    expect(reopenedMiddle.snapshot.tabs.map((tab) => tab.id)).toEqual([
      "generated-1",
      "generated-3",
      "generated-2",
    ]);
    expect(reopenedMiddle.snapshot.activeTabId).toBe("generated-2");
    expect(reopenedMiddle.snapshot.recentlyClosedTabs).toEqual([]);
  });

  it("consumes a recently closed duplicate and activates the already open replacement", async () => {
    const { workspace, save } = createHarness();
    const url = "https://kafka.console.aliyun.com/region/cn-shanghai/instances/instance-1";
    await workspace.dispatch({
      type: "open-url",
      product: "kafka",
      regionId: "cn-shanghai",
      url,
    });
    await workspace.dispatch({ type: "close-tab", tabId: "generated-1" });
    await workspace.dispatch({
      type: "open-url",
      product: "kafka",
      regionId: "cn-shanghai",
      url,
    });

    const result = await workspace.dispatch({ type: "reopen-closed-tab" });

    expect(result.snapshot.tabs.map((tab) => tab.id)).toEqual(["generated-2"]);
    expect(result.snapshot.activeTabId).toBe("generated-2");
    expect(result.snapshot.recentlyClosedTabs).toEqual([]);
    expect(save).toHaveBeenCalledTimes(4);
  });

  it("reopens a selected recently closed tab by id without consuming newer closed tabs", async () => {
    const { workspace } = createHarness();
    const urls = [
      "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
      "https://cs.console.aliyun.com/#/k8s/deployment?region=cn-beijing",
      "https://cs.console.aliyun.com/#/k8s/service?region=cn-beijing",
    ];
    for (const [index, url] of urls.entries()) {
      await workspace.dispatch({
        type: "open-url",
        product: "ack",
        regionId: "cn-beijing",
        url,
        title: `tab ${index + 1}`,
      });
    }
    await workspace.dispatch({ type: "close-tab", tabId: "generated-2" });
    await workspace.dispatch({ type: "close-tab", tabId: "generated-3" });

    const reopened = await workspace.dispatch({
      type: "reopen-closed-tab",
      tabId: "generated-2",
    });

    expect(reopened.ok).toBe(true);
    expect(reopened.snapshot.tabs.map((tab) => tab.id)).toEqual([
      "generated-1",
      "generated-2",
    ]);
    expect(reopened.snapshot.activeTabId).toBe("generated-2");
    expect(reopened.snapshot.recentlyClosedTabs.map((tab) => tab.id)).toEqual(["generated-3"]);
    await expect(workspace.dispatch({
      type: "reopen-closed-tab",
      tabId: "missing",
    })).resolves.toMatchObject({ ok: false, error: "最近关闭标签不存在" });
  });

  it("keeps reopening closed tabs as a no-op when there is no closed history", async () => {
    const { workspace, save } = createHarness();

    const result = await workspace.dispatch({ type: "reopen-closed-tab" });

    expect(result).toMatchObject({ ok: true, snapshot: { recentlyClosedTabs: [] } });
    expect(save).not.toHaveBeenCalled();
  });

  it("returns batch close target ids and rejects direct batch close dispatch", async () => {
    const tabs = [
      createTab({ id: "active", taskStatus: "doing", pinned: false }),
      createTab({
        id: "done-pinned",
        url: "https://cs.console.aliyun.com/#/k8s/deployment?region=cn-beijing",
        taskStatus: "done",
        pinned: true,
      }),
      createTab({
        id: "done-unpinned",
        url: "https://cs.console.aliyun.com/#/k8s/service?region=cn-beijing",
        taskStatus: "done",
        pinned: false,
      }),
    ];
    const initial: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      tabs,
      activeTabId: "active",
      onboardingComplete: true,
    };
    const { workspace: restoredWorkspace, save } = createHarness(initial);
    await restoredWorkspace.restore();

    expect(restoredWorkspace.getBatchCloseTabIds("others")).toEqual(["done-pinned", "done-unpinned"]);
    expect(restoredWorkspace.getBatchCloseTabIds("completed")).toEqual(["done-pinned", "done-unpinned"]);
    expect(restoredWorkspace.getBatchCloseTabIds("unpinned")).toEqual(["active", "done-unpinned"]);
    await expect(restoredWorkspace.dispatch({
      type: "close-tabs",
      scope: "completed",
    })).resolves.toMatchObject({
      ok: false,
      error: "批量关闭需要主进程逐个确认页面关闭",
    });
    expect(save).not.toHaveBeenCalled();
  });
});

describe("Workspace tab metadata and recent visits", () => {
  it("persists pinned and task status changes without rewriting identical values", async () => {
    const { workspace, save } = createHarness();
    await workspace.dispatch({
      type: "open-url",
      product: "ack",
      regionId: "cn-beijing",
      url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
    });
    save.mockClear();

    const pinned = await workspace.dispatch({
      type: "set-tab-pinned",
      tabId: "generated-1",
      pinned: true,
    });
    expect(pinned.snapshot.tabs[0]).toMatchObject({ pinned: true, taskStatus: null });
    await workspace.dispatch({ type: "set-tab-pinned", tabId: "generated-1", pinned: true });
    expect(save).toHaveBeenCalledOnce();

    const doing = await workspace.dispatch({
      type: "set-tab-task-status",
      tabId: "generated-1",
      taskStatus: "doing",
    });
    expect(doing.snapshot.tabs[0].taskStatus).toBe("doing");
    await workspace.dispatch({
      type: "set-tab-task-status",
      tabId: "generated-1",
      taskStatus: "doing",
    });
    expect(save).toHaveBeenCalledTimes(2);

    await expect(workspace.dispatch({
      type: "set-tab-pinned",
      tabId: "missing",
      pinned: true,
    })).resolves.toMatchObject({ ok: false, error: "标签页不存在" });
  });

  it("upserts normalized stable console visits on open, activation, URL, and title changes", async () => {
    const { workspace } = createHarness();
    const firstUrl = "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing&spm=first";
    const equivalentUrl = "https://cs.console.aliyun.com/#/k8s/cluster/list?spm=second&region=cn-beijing";
    await workspace.dispatch({
      type: "open-url",
      product: "ack",
      regionId: "cn-beijing",
      url: firstUrl,
      title: "集群列表",
    });
    await workspace.dispatch({
      type: "open-url",
      product: "ack",
      regionId: "cn-beijing",
      url: "https://cs.console.aliyun.com/#/k8s/deployment?region=cn-beijing",
      title: "工作负载",
    });

    const activated = await workspace.dispatch({ type: "activate-tab", tabId: "generated-1" });
    expect(activated.snapshot.recentVisits.map((visit) => visit.title)).toEqual([
      "集群列表",
      "工作负载",
    ]);

    await workspace.dispatch({
      type: "update-tab",
      tabId: "generated-1",
      url: equivalentUrl,
    });
    const renamed = await workspace.dispatch({
      type: "update-tab",
      tabId: "generated-1",
      title: "生产集群",
    });
    expect(renamed.snapshot.recentVisits).toHaveLength(2);
    expect(renamed.snapshot.recentVisits[0]).toMatchObject({
      url: equivalentUrl,
      title: "生产集群",
      product: "ack",
      regionId: "cn-beijing",
    });
    expect(renamed.snapshot.recentVisits[0].visitedAt).toBeGreaterThan(
      renamed.snapshot.recentVisits[1].visitedAt,
    );
  });

  it("keeps only the 50 most recent stable console visits", async () => {
    const { workspace } = createHarness();
    for (let index = 0; index <= MAX_RECENT_VISITS; index += 1) {
      await workspace.dispatch({
        type: "open-url",
        product: "ack",
        regionId: "cn-beijing",
        url: `https://cs.console.aliyun.com/#/k8s/resource/${index}?region=cn-beijing`,
        title: `resource-${index}`,
      });
    }

    const visits = workspace.getSnapshot().recentVisits;
    expect(visits).toHaveLength(MAX_RECENT_VISITS);
    expect(visits[0].title).toBe(`resource-${MAX_RECENT_VISITS}`);
    expect(visits.at(-1)?.title).toBe("resource-1");
  });
});

describe("Workspace favorites", () => {
  it("adds a parsed console target, preserves its URL, and rejects a normalized duplicate", async () => {
    const { workspace, save } = createHarness();
    const original =
      "https://cs.console.aliyun.com/#/k8s/deployment?region=cn-shanghai&spm=first";
    await workspace.dispatch({
      type: "open-url",
      product: "ack",
      regionId: "cn-shanghai",
      url: original,
    });

    const added = await workspace.dispatch({
      type: "add-favorite",
      tabId: "generated-1",
      name: "  上海工作负载  ",
    });

    expect(added.ok).toBe(true);
    expect(added.snapshot.favorites).toEqual([
      expect.objectContaining({
        id: "generated-2",
        name: "上海工作负载",
        product: "ack",
        regionId: "cn-shanghai",
        url: original,
      }),
    ]);

    await workspace.dispatch({
      type: "update-tab",
      tabId: "generated-1",
      url: "https://cs.console.aliyun.com/#/k8s/deployment?spm=other&region=cn-shanghai",
    });
    const duplicate = await workspace.dispatch({
      type: "add-favorite",
      tabId: "generated-1",
      name: "duplicate",
    });

    expect(duplicate).toMatchObject({ ok: false, error: "当前页面已经收藏" });
    expect(duplicate.snapshot.favorites).toHaveLength(1);
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("rejects pages without a recognizable console product and region", async () => {
    const { workspace, save } = createHarness();
    await workspace.dispatch({
      type: "open-entry",
      product: "ack",
      regionId: "cn-beijing",
    });
    await workspace.dispatch({
      type: "update-tab",
      tabId: "generated-1",
      url: "https://account.aliyun.com/login/login.htm",
    });
    save.mockClear();

    const result = await workspace.dispatch({
      type: "add-favorite",
      tabId: "generated-1",
      name: "invalid favorite",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "登录页面不能收藏",
      snapshot: { favorites: [] },
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("favorites a DMS page without inventing a region", async () => {
    const { workspace } = createHarness();
    await workspace.dispatch({
      type: "open-url",
      product: "dms",
      regionId: null,
      url: "https://dmsnext.console.aliyun.com/workbench?source=nav",
      title: "SQL 窗口",
    });

    const result = await workspace.dispatch({
      type: "add-favorite",
      tabId: "generated-1",
      name: "SQL 窗口",
    });

    expect(result.ok).toBe(true);
    expect(result.snapshot.favorites).toEqual([
      expect.objectContaining({
        product: "dms",
        regionId: null,
        url: "https://dmsnext.console.aliyun.com/workbench?source=nav",
      }),
    ]);
  });

  it("favorites a Flow pipeline as a Codeup page without inventing a region", async () => {
    const { workspace } = createHarness();
    await workspace.dispatch({
      type: "open-url",
      product: "codeup",
      regionId: null,
      url: "https://flow.aliyun.com/pipelines/123?source=nav",
      title: "发布流水线",
    });

    const result = await workspace.dispatch({
      type: "add-favorite",
      tabId: "generated-1",
      name: "发布流水线",
    });

    expect(result.ok).toBe(true);
    expect(result.snapshot.favorites).toEqual([
      expect.objectContaining({
        product: "codeup",
        regionId: null,
        url: "https://flow.aliyun.com/pipelines/123?source=nav",
      }),
    ]);
  });

  it("favorites the fixed SLS query without persisting a workspace region", async () => {
    const { workspace } = createHarness();
    await workspace.dispatch({
      type: "open-url",
      product: "sls",
      regionId: null,
      url: SLS_TEST_QUERY_URL,
      title: "示例应用日志",
    });

    const result = await workspace.dispatch({
      type: "add-favorite",
      tabId: "generated-1",
      name: "示例应用日志",
    });

    expect(result.snapshot.favorites).toEqual([
      expect.objectContaining({
        product: "sls",
        regionId: null,
        url: SLS_TEST_QUERY_URL,
      }),
    ]);
  });

  it("renames and removes favorites without persisting unchanged or missing records", async () => {
    const initial: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      favorites: [createFavorite()],
    };
    const { workspace, save } = createHarness(initial);
    await workspace.restore();

    const renamed = await workspace.dispatch({
      type: "rename-favorite",
      favoriteId: "favorite-1",
      name: "  新名称  ",
    });
    expect(renamed.snapshot.favorites[0].name).toBe("新名称");
    expect(save).toHaveBeenCalledOnce();

    await workspace.dispatch({
      type: "rename-favorite",
      favoriteId: "favorite-1",
      name: "新名称",
    });
    await workspace.dispatch({ type: "remove-favorite", favoriteId: "missing" });
    expect(save).toHaveBeenCalledOnce();

    const removed = await workspace.dispatch({
      type: "remove-favorite",
      favoriteId: "favorite-1",
    });
    expect(removed.snapshot.favorites).toEqual([]);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("restores only the most recently removed favorite", async () => {
    const first = createFavorite({ id: "favorite-1", name: "北京集群" });
    const second = createFavorite({
      id: "favorite-2",
      name: "上海集群",
      regionId: "cn-shanghai",
      url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-shanghai",
    });
    const initial: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      favorites: [first, second],
    };
    const { workspace, save } = createHarness(initial);
    await workspace.restore();

    await workspace.dispatch({ type: "remove-favorite", favoriteId: first.id });
    const removed = await workspace.dispatch({ type: "remove-favorite", favoriteId: second.id });
    expect(removed.snapshot.favorites).toEqual([]);

    const stale = await workspace.dispatch({ type: "restore-favorite", favoriteId: first.id });
    expect(stale).toMatchObject({ ok: false, error: "该收藏已无法撤销" });
    expect(stale.snapshot.favorites).toEqual([]);

    const restored = await workspace.dispatch({
      type: "restore-favorite",
      favoriteId: second.id,
    });
    expect(restored.ok).toBe(true);
    expect(restored.snapshot.favorites).toEqual([second]);
    expect(save).toHaveBeenCalledTimes(3);

    const repeated = await workspace.dispatch({
      type: "restore-favorite",
      favoriteId: second.id,
    });
    expect(repeated).toMatchObject({ ok: false, error: "该收藏已无法撤销" });
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("reorders favorites and restores a removed favorite at its previous position", async () => {
    const first = createFavorite({ id: "favorite-1", name: "北京集群" });
    const second = createFavorite({
      id: "favorite-2",
      name: "上海集群",
      regionId: "cn-shanghai",
      url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-shanghai",
    });
    const third = createFavorite({
      id: "favorite-3",
      name: "杭州集群",
      regionId: "cn-hangzhou",
      url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-hangzhou",
    });
    const initial: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      favorites: [first, second, third],
    };
    const { workspace, save } = createHarness(initial);
    await workspace.restore();

    const moved = await workspace.dispatch({
      type: "move-favorite",
      favoriteId: second.id,
      toIndex: 0,
    });
    expect(moved.snapshot.favorites.map((favorite) => favorite.id)).toEqual([
      second.id,
      first.id,
      third.id,
    ]);
    await workspace.dispatch({
      type: "move-favorite",
      favoriteId: second.id,
      toIndex: 0,
    });
    expect(save).toHaveBeenCalledOnce();

    const removed = await workspace.dispatch({ type: "remove-favorite", favoriteId: first.id });
    expect(removed.snapshot.favorites.map((favorite) => favorite.id)).toEqual([second.id, third.id]);
    const restored = await workspace.dispatch({ type: "restore-favorite", favoriteId: first.id });
    expect(restored.snapshot.favorites.map((favorite) => favorite.id)).toEqual([
      second.id,
      first.id,
      third.id,
    ]);
    await expect(workspace.dispatch({
      type: "move-favorite",
      favoriteId: third.id,
      toIndex: 3,
    })).resolves.toMatchObject({ ok: false, error: "收藏目标位置无效" });
    expect(save).toHaveBeenCalledTimes(3);
  });
});

describe("Workspace module shortcuts", () => {
  it.each([
    { product: "codeup" as const, url: "https://codeup.aliyun.com/org/sample-app", nextUrl: "https://codeup.aliyun.com/org/sample-app/commits?branch=main" },
    { product: "sls" as const, url: "https://sls.console.aliyun.com/lognext/project/demo/logsearch/sample-app", nextUrl: "https://sls.console.aliyun.com/lognext/project/demo/logsearch/sample-app?query=error" },
  ])("retains the $product shortcut through navigation, popup, close and restore", async ({ product, url, nextUrl }) => {
    const shortcut = { id: "sample-app", name: "sample-app", product, url, createdAt: 1 };
    const { workspace } = createHarness({ ...createDefaultSnapshot(), moduleShortcuts: [shortcut] });
    await workspace.restore();
    const opened = await workspace.dispatch({ type: "open-url", product, regionId: null, url });
    const tabId = opened.snapshot.activeTabId!;
    expect(opened.snapshot.tabs[0].moduleShortcutId).toBe(shortcut.id);

    await workspace.dispatch({ type: "update-tab", tabId, url: nextUrl });
    await workspace.dispatch({ type: "update-tab", tabId, url: "https://signin.aliyun.com/login.htm" });
    await workspace.dispatch({ type: "update-tab", tabId, url: nextUrl, loadState: "ready" });
    expect(workspace.getSnapshot().tabs[0]).toMatchObject({ url: nextUrl, moduleShortcutId: shortcut.id });

    const popup = await workspace.dispatch({ type: "open-url", product, regionId: null, url: `${nextUrl}&page=2`, sourceTabId: tabId });
    expect(popup.snapshot.tabs[1].moduleShortcutId).toBe(shortcut.id);
    await workspace.openConsolePopup({ product, regionId: null, url: `${nextUrl}&page=3` }, () => undefined, tabId);
    expect(workspace.getSnapshot().tabs[2].moduleShortcutId).toBe(shortcut.id);

    await workspace.dispatch({ type: "close-tab", tabId });
    expect(workspace.getSnapshot().recentlyClosedTabs[0].moduleShortcutId).toBe(shortcut.id);
    await workspace.dispatch({ type: "reopen-closed-tab", tabId });
    expect(workspace.getSnapshot().activeTabId).toBe(tabId);
    expect(workspace.getSnapshot().tabs.every((tab) => tab.moduleShortcutId === shortcut.id)).toBe(true);
    const restored = createHarness(workspace.getSnapshot()).workspace;
    await restored.restore();
    expect(restored.getSnapshot().tabs.every((tab) => tab.moduleShortcutId === shortcut.id)).toBe(true);
  });

  it("associates legacy tabs on navigation, switches shortcuts and clears cross-product associations", async () => {
    const shortcuts = ["sample-app", "sample-api"].map((name) => ({
      id: name, name, product: "codeup" as const, url: `https://codeup.aliyun.com/org/${name}`, createdAt: 1,
    }));
    const tab = createTab({ product: "codeup", regionId: null, url: shortcuts[0].url });
    const { workspace } = createHarness({ ...createDefaultSnapshot(), tabs: [tab], activeTabId: tab.id, moduleShortcuts: shortcuts });
    await workspace.restore();
    await workspace.dispatch({ type: "update-tab", tabId: tab.id, url: `${tab.url}/commits` });
    expect(workspace.getSnapshot().tabs[0].moduleShortcutId).toBe("sample-app");
    await workspace.dispatch({ type: "update-tab", tabId: tab.id, url: shortcuts[1].url });
    expect(workspace.getSnapshot().tabs[0].moduleShortcutId).toBe("sample-api");
    await workspace.dispatch({ type: "update-tab", tabId: tab.id, url: `${shortcuts[1].url}/branches` });
    expect(workspace.getSnapshot().tabs[0].moduleShortcutId).toBe("sample-api");

    await workspace.dispatch({ type: "open-url", product: "dms", regionId: null, url: "https://dms.aliyun.com/", sourceTabId: tab.id });
    expect(workspace.getSnapshot().tabs[1].moduleShortcutId).toBeUndefined();
    await workspace.dispatch({ type: "update-tab", tabId: tab.id, url: "https://dms.aliyun.com/" });
    expect(workspace.getSnapshot().tabs[0].product).toBe("dms");
    expect(workspace.getSnapshot().tabs[0].moduleShortcutId).toBeUndefined();
  });

  it("saves Codeup and SLS pages as named module shortcuts", async () => {
    const { workspace } = createHarness();
    await workspace.dispatch({
      type: "open-url",
      product: "codeup",
      regionId: null,
      url: "https://codeup.aliyun.com/org/sample-app/repository/123",
      title: "示例应用仓库",
    });

    const saved = await workspace.dispatch({
      type: "add-module-shortcut",
      tabId: "generated-1",
      name: "  示例应用仓库  ",
    });

    expect(saved).toMatchObject({
      ok: true,
      snapshot: {
        moduleShortcuts: [expect.objectContaining({
          id: "generated-2",
          name: "示例应用仓库",
          product: "codeup",
          url: "https://codeup.aliyun.com/org/sample-app/repository/123",
        })],
      },
    });

    await workspace.dispatch({
      type: "open-url",
      product: "sls",
      regionId: null,
      url: "https://sls.console.aliyun.com/lognext/project/sample-app/logsearch/runtime?slsRegion=cn-beijing",
      title: "运行日志",
    });
    const slsShortcut = await workspace.dispatch({
      type: "add-module-shortcut",
      tabId: "generated-3",
      name: "示例应用日志",
    });
    expect(slsShortcut.snapshot.moduleShortcuts).toEqual([
      expect.objectContaining({ product: "codeup", name: "示例应用仓库" }),
      expect.objectContaining({ product: "sls", name: "示例应用日志" }),
    ]);
  });

  it("rejects unsupported and duplicate module shortcut pages, then supports rename and removal", async () => {
    const { workspace } = createHarness();
    await workspace.dispatch({ type: "open-entry", product: "ack", regionId: "cn-beijing" });
    await expect(workspace.dispatch({
      type: "add-module-shortcut",
      tabId: "generated-1",
      name: "ACK",
    })).resolves.toMatchObject({ ok: false, error: "仅 Codeup 和 SLS 页面可保存快捷入口" });

    await workspace.dispatch({
      type: "open-url",
      product: "codeup",
      regionId: null,
      url: "https://codeup.aliyun.com/org/sample-app/repository/123",
    });
    await workspace.dispatch({ type: "add-module-shortcut", tabId: "generated-2", name: "示例应用" });
    await expect(workspace.dispatch({
      type: "add-module-shortcut",
      tabId: "generated-2",
      name: "重复",
    })).resolves.toMatchObject({ ok: false, error: "当前页面已经保存为快捷入口" });

    const renamed = await workspace.dispatch({
      type: "rename-module-shortcut",
      shortcutId: "generated-3",
      name: "核心仓库",
    });
    expect(renamed.snapshot.moduleShortcuts[0].name).toBe("核心仓库");
    const removed = await workspace.dispatch({ type: "remove-module-shortcut", shortcutId: "generated-3" });
    expect(removed.snapshot.moduleShortcuts).toEqual([]);
  });

  it("reorders module shortcuts and restores the last removed shortcut", async () => {
    const first: WorkspaceSnapshot["moduleShortcuts"][number] = {
      id: "shortcut-1",
      name: "核心仓库",
      product: "codeup",
      url: "https://codeup.aliyun.com/org/sample-app/repository/123",
      createdAt: 100,
    };
    const second: WorkspaceSnapshot["moduleShortcuts"][number] = {
      id: "shortcut-2",
      name: "运行日志",
      product: "sls",
      url: "https://sls.console.aliyun.com/lognext/project/sample-app/logsearch/runtime?slsRegion=cn-beijing",
      createdAt: 110,
    };
    const third: WorkspaceSnapshot["moduleShortcuts"][number] = {
      id: "shortcut-3",
      name: "发布流水线",
      product: "codeup",
      url: "https://flow.aliyun.com/pipelines/123",
      createdAt: 120,
    };
    const initial: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      moduleShortcuts: [first, second, third],
    };
    const { workspace, save } = createHarness(initial);
    await workspace.restore();

    const moved = await workspace.dispatch({
      type: "move-module-shortcut",
      shortcutId: third.id,
      toIndex: 1,
    });
    expect(moved.snapshot.moduleShortcuts.map((shortcut) => shortcut.id)).toEqual([
      first.id,
      third.id,
      second.id,
    ]);

    await workspace.dispatch({ type: "remove-module-shortcut", shortcutId: third.id });
    const restored = await workspace.dispatch({
      type: "restore-module-shortcut",
      shortcutId: third.id,
    });
    expect(restored.snapshot.moduleShortcuts.map((shortcut) => shortcut.id)).toEqual([
      first.id,
      third.id,
      second.id,
    ]);
    await expect(workspace.dispatch({
      type: "restore-module-shortcut",
      shortcutId: third.id,
    })).resolves.toMatchObject({ ok: false, error: "该快捷入口已无法撤销" });
    await expect(workspace.dispatch({
      type: "move-module-shortcut",
      shortcutId: "missing",
      toIndex: 0,
    })).resolves.toMatchObject({ ok: false, error: "快捷入口不存在" });
    expect(save).toHaveBeenCalledTimes(3);
  });
});

describe("Workspace module settings and logout", () => {
  it("deduplicates per-product regions in input order and rejects invalid replacements", async () => {
    const { workspace, save } = createHarness();

    const changed = await workspace.dispatch({
      type: "set-module-settings",
      selectedProducts: ["ack", "kafka"],
      productRegionIds: productRegionIds({
        ack: ["cn-shenzhen", "cn-beijing", "cn-shenzhen"],
        kafka: ["cn-shanghai"],
      }),
    });
    expect(changed.snapshot.productRegionIds).toMatchObject({
      ack: ["cn-shenzhen", "cn-beijing"],
      kafka: ["cn-shanghai"],
    });
    expect(save).toHaveBeenCalledOnce();

    const invalid = await workspace.dispatch({
      type: "set-module-settings",
      selectedProducts: ["ack"],
      productRegionIds: productRegionIds({ ack: ["cn-shenzhen", "not-a-region"] }),
    });
    expect(invalid).toMatchObject({ ok: false, error: "请选择有效地域" });
    expect(invalid.snapshot.productRegionIds.ack).toEqual(["cn-shenzhen", "cn-beijing"]);

    const emptySelectedAck = await workspace.dispatch({
      type: "set-module-settings",
      selectedProducts: ["ack"],
      productRegionIds: productRegionIds({ ack: [] }),
    });
    expect(emptySelectedAck).toMatchObject({ ok: false, error: "ACK 请至少选择一个地域" });
    expect(save).toHaveBeenCalledOnce();
  });

  it("persists module settings without deleting tabs, favorites, or disabled module regions", async () => {
    const openTab = createTab();
    const favorite = createFavorite();
    const initial: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      tabs: [openTab],
      activeTabId: openTab.id,
      favorites: [favorite],
      recentlyClosedTabs: [createTab({ id: "closed" })],
    };
    const { workspace, save } = createHarness(initial);
    await workspace.restore();

    const result = await workspace.dispatch({
      type: "set-module-settings",
      selectedProducts: ["sls", "ack", "sls"],
      productRegionIds: productRegionIds({
        ack: ["cn-shenzhen"],
        kafka: ["cn-hangzhou"],
        mse: ["cn-shanghai"],
      }),
    });

    expect(result.snapshot).toMatchObject({
      selectedProducts: ["sls", "ack"],
      productRegionIds: {
        ack: ["cn-shenzhen"],
        kafka: ["cn-hangzhou"],
        mse: ["cn-shanghai"],
      },
      tabs: [expect.objectContaining({ id: "tab-1" })],
      favorites: [favorite],
      recentlyClosedTabs: [expect.objectContaining({ id: "closed" })],
    });
    expect(save).toHaveBeenCalledOnce();

    await workspace.dispatch({
      type: "set-module-settings",
      selectedProducts: ["sls", "ack"],
      productRegionIds: productRegionIds({
        ack: ["cn-shenzhen"],
        kafka: ["cn-hangzhou"],
        mse: ["cn-shanghai"],
      }),
    });
    expect(save).toHaveBeenCalledOnce();
  });

  it("prevents enabling regional products without a configured region", async () => {
    const withoutMse: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      selectedProducts: ["ack"],
      productRegionIds: productRegionIds({
        ack: ["cn-hangzhou"],
        mse: [],
      }),
    };
    const firstHarness = createHarness(withoutMse);
    await firstHarness.workspace.restore();
    const enableMse = await firstHarness.workspace.dispatch({
      type: "set-module-settings",
      selectedProducts: ["ack", "mse"],
      productRegionIds: withoutMse.productRegionIds,
    });
    expect(enableMse).toMatchObject({
      ok: false,
      error: "MSE 仅支持北京和上海，请至少选择其中一个地域",
    });
    expect(firstHarness.save).not.toHaveBeenCalled();

    const removeAckRegion = await firstHarness.workspace.dispatch({
      type: "set-module-settings",
      selectedProducts: ["ack"],
      productRegionIds: productRegionIds({ ack: [] }),
    });
    expect(removeAckRegion).toMatchObject({ ok: false, error: "ACK 请至少选择一个地域" });
    expect(firstHarness.save).not.toHaveBeenCalled();
  });

  it("clears console and closed tabs on logout while preserving user preferences and favorites", async () => {
    const openTab = createTab({ id: "open" });
    const closedTab = createTab({ id: "closed" });
    const initial: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      tabs: [openTab],
      activeTabId: openTab.id,
      recentlyClosedTabs: [closedTab],
      recentVisits: [createRecentVisit()],
      favorites: [createFavorite()],
      productRegionIds: productRegionIds({
        ack: ["cn-shanghai", "cn-beijing"],
        kafka: ["cn-hangzhou"],
        mse: ["cn-shanghai"],
      }),
      sidebarCollapsed: true,
      onboardingComplete: true,
      windowBounds: { x: 20, y: 30, width: 1440, height: 900 },
      notice: "will be cleared",
    };
    const { workspace, save } = createHarness(initial);
    await workspace.restore();

    const result = await workspace.dispatch({ type: "clear-console-tabs" });

    expect(result.snapshot).toMatchObject({
      tabs: [],
      activeTabId: null,
      recentlyClosedTabs: [],
      recentVisits: [],
      favorites: [createFavorite()],
      productRegionIds: {
        ack: ["cn-shanghai", "cn-beijing"],
        kafka: ["cn-hangzhou"],
        mse: ["cn-shanghai"],
      },
      sidebarCollapsed: true,
      onboardingComplete: true,
      windowBounds: { x: 20, y: 30, width: 1440, height: 900 },
      notice: null,
    });
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
      ...result.snapshot,
      notice: null,
    }));
  });
});

describe("Workspace persistence failures", () => {
  it("combines sequential activation writes and flushes the latest state at exit", async () => {
    vi.useFakeTimers();
    const first = createTab();
    const second = createTab({ id: "second" });
    const { workspace, save } = createHarness({ ...createDefaultSnapshot(), tabs: [first, second], activeTabId: first.id });
    await workspace.restore();
    for (let i = 0; i < 100; i++) {
      await workspace.dispatch({ type: "activate-tab", tabId: i % 2 ? first.id : second.id });
    }
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].activeTabId).toBe(first.id);
    await workspace.dispatch({ type: "activate-tab", tabId: second.id });
    await workspace.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0].activeTabId).toBe(second.id);
    await vi.advanceTimersByTimeAsync(250);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("immediately saves important edits and retries a failed delayed write on the next operation", async () => {
    vi.useFakeTimers();
    const first = createTab();
    const second = createTab({ id: "second" });
    const { workspace, save } = createHarness({ ...createDefaultSnapshot(), tabs: [first, second], activeTabId: first.id });
    await workspace.restore();
    await workspace.dispatch({ type: "activate-tab", tabId: second.id });
    await workspace.dispatch({ type: "add-favorite", tabId: second.id, name: "saved" });
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].favorites[0].name).toBe("saved");
    save.mockRejectedValueOnce(new Error("disk full"));
    await workspace.dispatch({ type: "activate-tab", tabId: first.id });
    await vi.advanceTimersByTimeAsync(250);
    expect(workspace.getSnapshot().notice).toContain("保存失败");
    await workspace.dispatch({ type: "activate-tab", tabId: first.id });
    expect(save).toHaveBeenCalledTimes(3);
    expect(save.mock.calls[2][0].activeTabId).toBe(first.id);
  });

  it("commits multiple closed pages in one write and keeps the latest closed-tab order", async () => {
    const tabs = Array.from({ length: 12 }, (_, i) => createTab({ id: String(i) }));
    const { workspace, save } = createHarness({ ...createDefaultSnapshot(), tabs, activeTabId: "0" });
    await workspace.restore();
    await workspace.closeTabs(["missing", ...tabs.slice(1).map((tab) => tab.id)]);
    expect(workspace.getSnapshot().tabs.map((tab) => tab.id)).toEqual(["0"]);
    expect(workspace.getSnapshot().recentlyClosedTabs.map((tab) => tab.id)).toEqual(["11", "10", "9", "8", "7", "6", "5", "4", "3", "2"]);
    expect(save).toHaveBeenCalledOnce();
  });

  it("coalesces queued writes to the latest snapshot while retaining an in-flight write", async () => {
    const firstSave = createDeferredSave();
    const { workspace, save } = createHarness();
    save.mockImplementationOnce(() => firstSave.promise);
    const first = workspace.dispatch({ type: "open-entry", product: "ack", regionId: "cn-beijing" });
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    const updates = Array.from({ length: 20 }, (_, index) => workspace.dispatch({
      type: "set-window-bounds", bounds: { width: 1100 + index, height: 800 },
    }));
    firstSave.resolve();
    await Promise.all([first, ...updates]);
    await workspace.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0].windowBounds.width).toBe(1119);
  });

  it("keeps the mutation and retries its dirty snapshot when the same command becomes a no-op", async () => {
    const { workspace, save } = createHarness();
    const listener = vi.fn();
    workspace.subscribe(listener);
    save.mockRejectedValueOnce(new Error("disk full"));

    const failed = await workspace.dispatch({
      type: "open-entry",
      product: "ack",
      regionId: "cn-beijing",
    });

    expect(failed).toMatchObject({
      ok: false,
      error: "本地状态保存失败",
      snapshot: {
        activeTabId: "generated-1",
        notice: "本地状态保存失败，本次操作可能无法恢复",
      },
    });
    expect(failed.snapshot.tabs).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener.mock.calls[1][0].notice).toBeNull();
    expect(listener.mock.calls[2][0].notice).toBe("本地状态保存失败，本次操作可能无法恢复");
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].notice).toBeNull();

    const retried = await workspace.dispatch({
      type: "open-entry",
      product: "ack",
      regionId: "cn-beijing",
    });

    expect(retried).toMatchObject({
      ok: true,
      snapshot: {
        activeTabId: "generated-1",
        notice: "本地状态保存失败，本次操作可能无法恢复",
      },
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toEqual(save.mock.calls[0][0]);
  });

  it("replaces a failed dirty snapshot with the latest durable update", async () => {
    const { workspace, save } = createHarness();
    save.mockRejectedValueOnce(new Error("disk full"));
    await workspace.dispatch({
      type: "open-entry",
      product: "ack",
      regionId: "cn-beijing",
    });

    const updated = await workspace.dispatch({ type: "set-sidebar-collapsed", collapsed: true });

    expect(updated).toMatchObject({ ok: true, snapshot: { sidebarCollapsed: true } });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toMatchObject({
      activeTabId: "generated-1",
      sidebarCollapsed: true,
      notice: null,
    });
  });

  it("keeps concurrent saves ordered when an earlier save fails", async () => {
    const firstSave = createDeferredSave();
    const { workspace, save } = createHarness();
    save.mockImplementationOnce(() => firstSave.promise);

    const firstDispatch = workspace.dispatch({
      type: "open-entry",
      product: "ack",
      regionId: "cn-beijing",
    });
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    const secondDispatch = workspace.dispatch({ type: "set-sidebar-collapsed", collapsed: true });
    expect(save).toHaveBeenCalledOnce();

    firstSave.reject(new Error("disk full"));

    await expect(firstDispatch).resolves.toMatchObject({
      ok: false,
      error: "本地状态保存失败",
    });
    await expect(secondDispatch).resolves.toMatchObject({
      ok: true,
      snapshot: { sidebarCollapsed: true },
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toMatchObject({
      activeTabId: "generated-1",
      sidebarCollapsed: true,
    });
  });

  it("does not let an older successful save clear a newer dirty snapshot", async () => {
    const firstSave = createDeferredSave();
    const secondSave = createDeferredSave();
    const { workspace, save } = createHarness();
    save
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise);

    const firstDispatch = workspace.dispatch({
      type: "open-entry",
      product: "ack",
      regionId: "cn-beijing",
    });
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    const secondDispatch = workspace.dispatch({ type: "set-sidebar-collapsed", collapsed: true });

    firstSave.resolve();
    await expect(firstDispatch).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    secondSave.reject(new Error("disk full"));
    await expect(secondDispatch).resolves.toMatchObject({
      ok: false,
      error: "本地状态保存失败",
    });

    const retried = await workspace.dispatch({ type: "set-sidebar-collapsed", collapsed: true });

    expect(retried).toMatchObject({ ok: true, snapshot: { sidebarCollapsed: true } });
    expect(save).toHaveBeenCalledTimes(3);
    expect(save.mock.calls[2][0]).toEqual(save.mock.calls[1][0]);
  });
});
