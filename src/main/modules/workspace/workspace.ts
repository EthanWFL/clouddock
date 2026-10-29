import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  MAX_RECENT_VISITS,
  WorkspaceCommandSchema,
  WorkspaceSnapshotSchema,
  createDefaultSnapshot,
  productLabel,
  type BatchCloseScope,
  type ConfigurableProduct,
  type Favorite,
  type ModuleShortcut,
  type Product,
  type ProductRegionIds,
  type RecentVisit,
  type WorkspaceCommand,
  type WorkspaceResult,
  type WorkspaceSnapshot,
  type WorkspaceTab,
} from "../../../shared/model";
import {
  buildConsoleEntryUrl,
  CONSOLE_HOME_URL,
  normalizeConsoleUrl,
  parseConsoleTarget,
  parseObservedConsoleTarget,
  type ConsoleTarget,
} from "../../../shared/console-url";
import { isKnownRegion } from "../../../shared/regions";
import { getTabModuleShortcut } from "../../../shared/workspace-display";
import {
  getProductRegionIds,
  isProductAvailableInRegion,
  isRegionalProduct,
  REGIONAL_PRODUCTS,
  type RegionalProduct,
} from "../../../shared/products";
import { decideNavigation, isAllowedAuthHost } from "../../../shared/navigation-policy";
import {
  parseExternalOpenUrl,
  parseExternalTargetUrl,
  type ExternalOpenHostRule,
} from "../external-open/external-open";
import type { SnapshotStore } from "./persistence";

export type WorkspaceListener = (snapshot: WorkspaceSnapshot) => void;
export type Unsubscribe = () => void;

interface WorkspaceDependencies {
  store: SnapshotStore;
  now?: () => number;
  id?: () => string;
  allowTestServer?: boolean;
  externalOpenHostRules?: readonly ExternalOpenHostRule[];
}

export class Workspace {
  private snapshot: WorkspaceSnapshot = createDefaultSnapshot();
  private readonly listeners = new Set<WorkspaceListener>();
  private readonly now: () => number;
  private readonly id: () => string;
  private saveQueue: Promise<void> = Promise.resolve();
  private scheduledSave: Promise<void> | null = null;
  private dirtySnapshot: WorkspaceSnapshot | null = null;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveFailed = false;
  private removedFavorite: { favorite: Favorite; index: number } | null = null;
  private removedModuleShortcut: { shortcut: ModuleShortcut; index: number } | null = null;

  constructor(private readonly dependencies: WorkspaceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.id = dependencies.id ?? randomUUID;
  }

  async restore(): Promise<WorkspaceSnapshot> {
    const restored = await this.dependencies.store.load();
    const canRestoreUrl = ({ url, product }: WorkspaceTab) => {
      if (product === "aliyun") {
        return parseExternalTargetUrl(url, this.dependencies.externalOpenHostRules).ok;
      }
      if (normalizeConsoleUrl(url) === CONSOLE_HOME_URL) return true;
      if (
        parseObservedConsoleTarget(url, this.dependencies.allowTestServer)
        || this.isAuthenticationUrl(url)
      ) return true;
      return Boolean(
        this.dependencies.allowTestServer
        && decideNavigation(url, "current", { allowTestServer: true }).kind === "allow-current",
      );
    };
    const restoreTab = (tab: WorkspaceTab): WorkspaceTab => ({
      ...tab,
      url: this.restoreConsoleUrl(tab),
      loadState: "deferred",
      canGoBack: false,
      canGoForward: false,
      isAuthenticating: false,
      externalHostname: undefined,
      errorMessage: undefined,
    });
    const tabs = restored.tabs.filter(canRestoreUrl).map(restoreTab);
    const recentlyClosedTabs = restored.recentlyClosedTabs
      .filter(canRestoreUrl)
      .map((tab) => ({
        ...tab,
        url: this.restoreConsoleUrl(tab),
        isAuthenticating: false,
        externalHostname: undefined,
      }));
    const favorites = restored.favorites.filter((favorite) =>
      parseObservedConsoleTarget(favorite.url, this.dependencies.allowTestServer),
    );
    const moduleShortcuts = restored.moduleShortcuts.filter((shortcut) => {
      const target = parseObservedConsoleTarget(shortcut.url, this.dependencies.allowTestServer);
      return target?.product === shortcut.product;
    });
    const recentVisits = restored.recentVisits.filter((visit) => this.isValidRecentVisit(visit));
    const removedEntries =
      tabs.length !== restored.tabs.length ||
      recentlyClosedTabs.length !== restored.recentlyClosedTabs.length ||
      favorites.length !== restored.favorites.length ||
      moduleShortcuts.length !== restored.moduleShortcuts.length ||
      recentVisits.length !== restored.recentVisits.length;
    this.snapshot = WorkspaceSnapshotSchema.parse({
      ...restored,
      tabs,
      activeTabId: tabs.some((tab) => tab.id === restored.activeTabId)
        ? restored.activeTabId
        : tabs[0]?.id ?? null,
      recentlyClosedTabs,
      favorites,
      moduleShortcuts,
      recentVisits,
      notice: removedEntries
        ? [restored.notice, "已忽略无法安全恢复的页面"].filter(Boolean).join("；")
        : restored.notice,
    });
    if ([...restored.tabs, ...restored.recentlyClosedTabs].some((tab) => this.isAuthenticationUrl(tab.url))) {
      this.dirtySnapshot = this.getDurableSnapshot(this.snapshot);
      // Remove legacy authentication callbacks from disk even without another user action.
      await this.flush().catch(() => undefined);
    }
    this.emit();
    return this.getSnapshot();
  }

  getSnapshot(): WorkspaceSnapshot {
    return structuredClone(this.snapshot);
  }

  subscribe(listener: WorkspaceListener): Unsubscribe {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.broadcastTimer) {
        clearTimeout(this.broadcastTimer);
        this.broadcastTimer = null;
      }
    };
  }

  getBatchCloseTabIds(scope: BatchCloseScope): string[] {
    switch (scope) {
      case "others":
        return this.snapshot.tabs
          .filter((tab) => tab.id !== this.snapshot.activeTabId)
          .map((tab) => tab.id);
      case "completed":
        return this.snapshot.tabs
          .filter((tab) => tab.taskStatus === "done")
          .map((tab) => tab.id);
      case "unpinned":
        return this.snapshot.tabs
          .filter((tab) => !tab.pinned)
          .map((tab) => tab.id);
    }
  }

  async dispatch(input: WorkspaceCommand): Promise<WorkspaceResult> {
    const parsed = WorkspaceCommandSchema.safeParse(input);
    if (!parsed.success) {
      return this.failure("操作参数无效");
    }

    const command = parsed.data;
    const runtimeOnly = command.type === "set-notice"
      || (command.type === "update-tab" && !command.url && !command.title && !command.target);
    const deferSave = command.type === "activate-tab" || command.type === "set-window-bounds";
    return this.applyMutation(() => this.apply(command), runtimeOnly, command.type === "update-tab", deferSave);
  }

  async closeTabs(tabIds: readonly string[]): Promise<WorkspaceResult> {
    return this.applyMutation(() => {
      let changed = false;
      for (const tabId of new Set(tabIds)) {
        if (this.snapshot.tabs.some((tab) => tab.id === tabId)) changed = this.closeTab(tabId) || changed;
      }
      return changed;
    });
  }

  async openExternalUrl(
    value: string,
    rules: readonly ExternalOpenHostRule[] = this.dependencies.externalOpenHostRules ?? [],
  ): Promise<WorkspaceResult> {
    const parsed = parseExternalOpenUrl(value, rules);
    if (!parsed.ok) return this.failure(parsed.reason);

    return this.applyMutation(() => {
      this.ensureProductRegion(parsed.target.product, parsed.target.regionId);
      return this.openValidatedUrl(
        parsed.target.product,
        parsed.target.regionId,
        parsed.target.url,
      );
    });
  }

  async openConsolePopup(target: ConsoleTarget, onCreated: (tabId: string) => void, sourceTabId?: string): Promise<WorkspaceResult> {
    return this.applyMutation(() => {
      this.ensureProductRegion(target.product, target.regionId);
      this.openValidatedUrl(target.product, target.regionId, target.url, undefined, false, sourceTabId);
      // Register transient request data before subscribers activate the new tab.
      onCreated(this.snapshot.activeTabId!);
      return true;
    });
  }

  private async applyMutation(mutate: () => boolean, runtimeOnly = false, coalesceBroadcast = false, deferSave = false): Promise<WorkspaceResult> {
    try {
      const before = this.snapshot;
      const changed = mutate();
      if (changed) {
        if (coalesceBroadcast) this.scheduleBroadcast();
        else this.emit();
      }
      if (changed && !runtimeOnly) {
        const durableAfter = this.getDurableSnapshot(this.snapshot);
        if (!isDeepStrictEqual(this.getDurableSnapshot(before), durableAfter)) {
          this.dirtySnapshot = durableAfter;
        }
      }
      if (this.dirtySnapshot) {
        if (!this.saveFailed && (deferSave || (runtimeOnly && this.saveTimer))) this.scheduleSave();
        else await this.flush();
      }
      return this.success();
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : "操作失败");
    }
  }

  private apply(command: WorkspaceCommand): boolean {
    switch (command.type) {
      case "complete-onboarding": {
        const selectedProducts = this.validateProducts(command.selectedProducts);
        const productRegionIds = this.validateProductRegionIds(command.productRegionIds);
        this.ensureSelectedProductsHaveRegions(selectedProducts, productRegionIds);
        if (!selectedProducts.includes(command.initialProduct)) {
          throw new Error("首次打开的产品必须属于已选模块");
        }
        const initialRegionId = isRegionalProduct(command.initialProduct)
          ? getProductRegionIds(command.initialProduct, productRegionIds)[0] ?? null
          : null;
        this.snapshot = {
          ...this.snapshot,
          onboardingComplete: true,
          selectedProducts,
          productRegionIds,
          notice: null,
        };
        this.openUrl(
          command.initialProduct,
          initialRegionId,
          buildConsoleEntryUrl(command.initialProduct, initialRegionId),
        );
        return true;
      }
      case "open-entry": {
        this.ensureProductRegion(command.product, command.regionId);
        if (command.product === "codeup" || isRegionalProduct(command.product)) {
          const existing = this.findMostRecentTab(command.product, command.regionId);
          if (existing) return this.activateTab(existing.id);
        }
        return this.openUrl(
          command.product,
          command.regionId,
          buildConsoleEntryUrl(command.product, command.regionId),
        );
      }
      case "open-console-home":
        return this.openConsoleHome();
      case "open-pasted-url":
        return this.openPastedUrl(command.url);
      case "open-pasted-urls":
        return this.openPastedUrls(command.urls);
      case "open-url":
        this.ensureProductRegion(command.product, command.regionId);
        return this.openUrl(command.product, command.regionId, command.url, command.title, command.sourceTabId);
      case "activate-tab":
        return this.activateTab(command.tabId);
      case "set-tab-pinned":
        return this.setTabPinned(command.tabId, command.pinned);
      case "set-tab-task-status":
        return this.setTabTaskStatus(command.tabId, command.taskStatus);
      case "move-tab":
        return this.moveTab(command.tabId, command.toIndex);
      case "close-tab":
        return this.closeTab(command.tabId);
      case "reopen-closed-tab":
        return this.reopenClosedTab(command.tabId);
      case "close-tabs":
        throw new Error("批量关闭需要主进程逐个确认页面关闭");
      case "update-tab":
        return this.updateTab(command);
      case "add-favorite":
        return this.addFavorite(command.tabId, command.name);
      case "rename-favorite":
        return this.renameFavorite(command.favoriteId, command.name);
      case "move-favorite":
        return this.moveFavorite(command.favoriteId, command.toIndex);
      case "remove-favorite":
        return this.removeFavorite(command.favoriteId);
      case "restore-favorite":
        return this.restoreFavorite(command.favoriteId);
      case "add-module-shortcut":
        return this.addModuleShortcut(command.tabId, command.name);
      case "rename-module-shortcut":
        return this.renameModuleShortcut(command.shortcutId, command.name);
      case "move-module-shortcut":
        return this.moveModuleShortcut(command.shortcutId, command.toIndex);
      case "remove-module-shortcut":
        return this.removeModuleShortcut(command.shortcutId);
      case "restore-module-shortcut":
        return this.restoreModuleShortcut(command.shortcutId);
      case "set-module-settings":
        {
          const selectedProducts = this.validateProducts(command.selectedProducts);
          const productRegionIds = this.validateProductRegionIds(command.productRegionIds);
          this.ensureSelectedProductsHaveRegions(selectedProducts, productRegionIds);
          if (
            isDeepStrictEqual(this.snapshot.selectedProducts, selectedProducts) &&
            isDeepStrictEqual(this.snapshot.productRegionIds, productRegionIds)
          ) return false;
          this.snapshot = {
            ...this.snapshot,
            selectedProducts,
            productRegionIds,
            notice: null,
          };
        }
        return true;
      case "set-tab-filters":
        if (
          this.snapshot.productFilter === command.productFilter
          && this.snapshot.taskFilter === command.taskFilter
        ) return false;
        this.snapshot = {
          ...this.snapshot,
          productFilter: command.productFilter,
          taskFilter: command.taskFilter,
        };
        return true;
      case "set-sidebar-collapsed":
        if (this.snapshot.sidebarCollapsed === command.collapsed) return false;
        this.snapshot = { ...this.snapshot, sidebarCollapsed: command.collapsed };
        return true;
      case "set-window-bounds":
        if (isDeepStrictEqual(this.snapshot.windowBounds, command.bounds)) return false;
        this.snapshot = { ...this.snapshot, windowBounds: command.bounds };
        return true;
      case "set-notice":
        if (this.snapshot.notice === command.notice) return false;
        this.snapshot = { ...this.snapshot, notice: command.notice };
        return true;
      case "clear-console-tabs":
        this.snapshot = {
          ...this.snapshot,
          tabs: [],
          activeTabId: null,
          recentlyClosedTabs: [],
          recentVisits: [],
          notice: null,
        };
        return true;
    }
  }

  private openUrl(
    product: WorkspaceTab["product"],
    regionId: string | null,
    url: string,
    title?: string,
    sourceTabId?: string,
  ): boolean {
    const navigation = decideNavigation(url, "popup", {
      allowTestServer: this.dependencies.allowTestServer,
    });
    if (navigation.kind !== "open-console-tab") {
      throw new Error("只允许打开受信任的阿里云控制台链接");
    }
    if (
      !this.dependencies.allowTestServer &&
      (navigation.target.product !== product || navigation.target.regionId !== regionId)
    ) {
      throw new Error("控制台链接与产品或地域不匹配");
    }
    return this.openValidatedUrl(product, regionId, url, title, true, sourceTabId);
  }

  private openValidatedUrl(
    product: WorkspaceTab["product"],
    regionId: string | null,
    url: string,
    title?: string,
    reuseExisting = true,
    sourceTabId?: string,
  ): boolean {
    const normalized = normalizeConsoleUrl(url);
    const existing = this.snapshot.tabs.find(
      (tab) =>
        tab.product === product &&
        tab.regionId === regionId &&
        normalizeConsoleUrl(tab.url) === normalized,
    );
    if (reuseExisting && existing) return this.activateTab(existing.id);

    const sourceTab = this.snapshot.tabs.find((tab) => tab.id === sourceTabId);
    const sourceShortcut = sourceTab ? getTabModuleShortcut(sourceTab, this.snapshot.moduleShortcuts) : undefined;
    const moduleShortcutId = getTabModuleShortcut({ product, url, moduleShortcutId: sourceShortcut?.id }, this.snapshot.moduleShortcuts)?.id;
    const timestamp = this.now();
    const tab: WorkspaceTab = {
      id: this.id(),
      product,
      regionId,
      url,
      ...(moduleShortcutId ? { moduleShortcutId } : {}),
      title: title?.trim() || productLabel(product),
      createdAt: timestamp,
      lastActiveAt: timestamp,
      pinned: false,
      taskStatus: null,
      loadState: "deferred",
      canGoBack: false,
      canGoForward: false,
      isAuthenticating: this.isAuthenticationUrl(url),
      externalHostname: this.isAuthenticationUrl(url) ? new URL(url).hostname : undefined,
    };
    this.snapshot = {
      ...this.snapshot,
      tabs: [...this.snapshot.tabs, tab],
      activeTabId: tab.id,
      notice: null,
    };
    this.upsertRecentVisit(tab, timestamp);
    return true;
  }

  private openPastedUrl(url: string): boolean {
    return this.openPastedUrls([url]);
  }

  private openPastedUrls(urls: readonly string[]): boolean {
    const targets = urls.map((url) => this.parsePastedUrl(url));
    const uniqueTargets = new Map<string, (typeof targets)[number]>();
    for (const target of targets) {
      const normalized = normalizeConsoleUrl(target.url);
      if (!uniqueTargets.has(normalized)) uniqueTargets.set(normalized, target);
    }

    const before = this.snapshot;
    try {
      let changed = false;
      for (const [normalized, target] of uniqueTargets) {
        changed = (
          normalized === CONSOLE_HOME_URL
            ? this.openConsoleHome()
            : this.openUrl(target.product, target.regionId, target.url)
        ) || changed;
      }
      return changed;
    } catch (error) {
      this.snapshot = before;
      throw error;
    }
  }

  private parsePastedUrl(url: string) {
    const parsed = new URL(url);
    const navigation = decideNavigation(parsed.toString(), "popup", {
      allowTestServer: this.dependencies.allowTestServer,
    });
    const secureUrl = navigation.kind === "load-secure-url" ? navigation.url : parsed.toString();
    const target = navigation.kind === "open-console-tab"
      ? navigation.target
      : navigation.kind === "load-secure-url"
        ? parseConsoleTarget(secureUrl)
        : null;
    if (!target) throw new Error("仅支持已接入的阿里云控制台链接");
    this.ensureProductRegion(target.product, target.regionId);
    return { ...target, url: secureUrl };
  }

  private openConsoleHome(): boolean {
    const existing = this.snapshot.tabs.find(
      (tab) => normalizeConsoleUrl(tab.url) === CONSOLE_HOME_URL,
    );
    if (existing) return this.activateTab(existing.id);

    const timestamp = this.now();
    const tab: WorkspaceTab = {
      id: this.id(),
      product: "aliyun",
      regionId: null,
      url: CONSOLE_HOME_URL,
      title: "控制台首页",
      createdAt: timestamp,
      lastActiveAt: timestamp,
      pinned: false,
      taskStatus: null,
      loadState: "deferred",
      canGoBack: false,
      canGoForward: false,
      isAuthenticating: false,
    };
    this.snapshot = {
      ...this.snapshot,
      tabs: [...this.snapshot.tabs, tab],
      activeTabId: tab.id,
      notice: null,
    };
    return true;
  }

  private setTabPinned(tabId: string, pinned: boolean): boolean {
    const tab = this.snapshot.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error("标签页不存在");
    if (tab.pinned === pinned) return false;
    this.snapshot = {
      ...this.snapshot,
      tabs: this.snapshot.tabs.map((candidate) =>
        candidate.id === tabId ? { ...candidate, pinned } : candidate),
    };
    return true;
  }

  private setTabTaskStatus(
    tabId: string,
    taskStatus: Extract<WorkspaceCommand, { type: "set-tab-task-status" }>["taskStatus"],
  ): boolean {
    const tab = this.snapshot.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error("标签页不存在");
    if (tab.taskStatus === taskStatus) return false;
    this.snapshot = {
      ...this.snapshot,
      tabs: this.snapshot.tabs.map((candidate) =>
        candidate.id === tabId ? { ...candidate, taskStatus } : candidate),
    };
    return true;
  }

  private findMostRecentTab(
    product: WorkspaceTab["product"],
    regionId: string | null,
  ): WorkspaceTab | undefined {
    const active = this.snapshot.tabs.find(
      (tab) =>
        tab.id === this.snapshot.activeTabId &&
        tab.product === product &&
        tab.regionId === regionId,
    );
    if (active) return active;

    return this.snapshot.tabs.reduce<WorkspaceTab | undefined>((mostRecent, tab) => {
      if (tab.product !== product || tab.regionId !== regionId) return mostRecent;
      if (!mostRecent || tab.lastActiveAt > mostRecent.lastActiveAt) return tab;
      return mostRecent;
    }, undefined);
  }

  private activateTab(tabId: string): boolean {
    const tab = this.snapshot.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error("标签页不存在");
    if (this.snapshot.activeTabId === tabId) return false;
    const timestamp = this.now();
    this.snapshot = {
      ...this.snapshot,
      tabs: this.snapshot.tabs.map((candidate) =>
        candidate.id === tabId ? { ...candidate, lastActiveAt: timestamp } : candidate,
      ),
      activeTabId: tabId,
      notice: null,
    };
    this.upsertRecentVisit({ ...tab, lastActiveAt: timestamp }, timestamp);
    return true;
  }

  private moveTab(tabId: string, toIndex: number): boolean {
    const fromIndex = this.snapshot.tabs.findIndex((tab) => tab.id === tabId);
    if (fromIndex < 0) throw new Error("标签页不存在");
    if (toIndex >= this.snapshot.tabs.length) throw new Error("标签目标位置无效");
    if (fromIndex === toIndex) return false;

    const tabs = [...this.snapshot.tabs];
    const [moving] = tabs.splice(fromIndex, 1);
    tabs.splice(toIndex, 0, moving);
    this.snapshot = { ...this.snapshot, tabs, notice: null };
    return true;
  }

  private closeTab(tabId: string): boolean {
    const index = this.snapshot.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) throw new Error("标签页不存在");
    const closing = this.snapshot.tabs[index];
    const remaining = this.snapshot.tabs.filter((tab) => tab.id !== tabId);
    let activeTabId = this.snapshot.activeTabId;
    if (activeTabId === tabId) {
      activeTabId = remaining[Math.min(index, remaining.length - 1)]?.id ?? null;
    }
    const deferredClosing: WorkspaceTab = {
      ...closing,
      url: this.restoreConsoleUrl(closing),
      loadState: "deferred",
      canGoBack: false,
      canGoForward: false,
      isAuthenticating: false,
      externalHostname: undefined,
      errorMessage: undefined,
    };
    this.snapshot = {
      ...this.snapshot,
      tabs: remaining,
      activeTabId,
      recentlyClosedTabs: [deferredClosing, ...this.snapshot.recentlyClosedTabs].slice(0, 10),
      notice: null,
    };
    return true;
  }

  private reopenClosedTab(tabId?: string): boolean {
    const index = tabId
      ? this.snapshot.recentlyClosedTabs.findIndex((tab) => tab.id === tabId)
      : 0;
    if (index < 0) {
      if (tabId) throw new Error("最近关闭标签不存在");
      return false;
    }
    const tab = this.snapshot.recentlyClosedTabs[index];
    if (!tab) return false;
    const rest = this.snapshot.recentlyClosedTabs.filter((_, candidateIndex) => candidateIndex !== index);
    const duplicate = this.snapshot.tabs.some(
      (candidate) => normalizeConsoleUrl(candidate.url) === normalizeConsoleUrl(tab.url),
    );
    this.snapshot = {
      ...this.snapshot,
      tabs: duplicate ? this.snapshot.tabs : [...this.snapshot.tabs, { ...tab, lastActiveAt: this.now() }],
      activeTabId: duplicate
        ? this.snapshot.tabs.find(
            (candidate) => normalizeConsoleUrl(candidate.url) === normalizeConsoleUrl(tab.url),
          )?.id ?? this.snapshot.activeTabId
        : tab.id,
      recentlyClosedTabs: rest,
      notice: null,
    };
    return true;
  }

  private updateTab(command: Extract<WorkspaceCommand, { type: "update-tab" }>): boolean {
    const index = this.snapshot.tabs.findIndex((tab) => tab.id === command.tabId);
    if (index < 0) return false;
    if (
      command.url &&
      decideNavigation(command.url, "current", {
        allowTestServer: this.dependencies.allowTestServer,
      }).kind !== "allow-current"
    ) {
      throw new Error("已阻止不受信任的页面地址");
    }
    const current = this.snapshot.tabs[index];
    const target = (command.url ? parseConsoleTarget(command.url) : null) ?? command.target;
    if (target) this.ensureProductRegion(target.product, target.regionId);
    const externalHostname = command.url && !target
      ? new URL(command.url).hostname
      : undefined;
    const isAuthenticating = command.url
      ? this.isAuthenticationUrl(command.url) || Boolean(externalHostname)
      : current.isAuthenticating;
    const updated: WorkspaceTab = {
      ...current,
      ...(target ? { product: target.product, regionId: target.regionId } : {}),
      ...(command.url && target ? { url: command.url } : {}),
      ...(command.url ? { isAuthenticating, externalHostname } : {}),
      ...(command.title?.trim() ? { title: command.title.trim() } : {}),
      ...(command.loadState ? { loadState: command.loadState } : {}),
      ...(typeof command.canGoBack === "boolean" ? { canGoBack: command.canGoBack } : {}),
      ...(typeof command.canGoForward === "boolean" ? { canGoForward: command.canGoForward } : {}),
      ...(command.errorMessage ? { errorMessage: command.errorMessage } : {}),
    };
    updated.moduleShortcutId = getTabModuleShortcut({
      ...updated,
      moduleShortcutId: getTabModuleShortcut(current, this.snapshot.moduleShortcuts)?.id,
    }, this.snapshot.moduleShortcuts)?.id;
    if (!updated.moduleShortcutId) delete updated.moduleShortcutId;
    if (command.loadState && command.loadState !== "error" && command.loadState !== "crashed") {
      updated.errorMessage = undefined;
    }
    if (
      updated.product === current.product &&
      updated.regionId === current.regionId &&
      updated.url === current.url &&
      updated.moduleShortcutId === current.moduleShortcutId &&
      updated.title === current.title &&
      updated.loadState === current.loadState &&
      updated.canGoBack === current.canGoBack &&
      updated.canGoForward === current.canGoForward &&
      updated.isAuthenticating === current.isAuthenticating &&
      updated.externalHostname === current.externalHostname &&
      updated.errorMessage === current.errorMessage
    ) {
      return false;
    }
    const recentVisitChanged = updated.url !== current.url || updated.title !== current.title;
    this.snapshot = {
      ...this.snapshot,
      tabs: this.snapshot.tabs.map((tab) => (tab.id === command.tabId ? updated : tab)),
    };
    if (recentVisitChanged) this.upsertRecentVisit(updated);
    return true;
  }

  private addFavorite(tabId: string, name: string): boolean {
    const tab = this.snapshot.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error("标签页不存在");
    if (tab.isAuthenticating) throw new Error("登录页面不能收藏");
    const target = parseConsoleTarget(tab.url);
    if (!target) throw new Error("当前页面无法识别控制台产品，不能收藏");
    const normalized = normalizeConsoleUrl(tab.url);
    if (this.snapshot.favorites.some((favorite) => normalizeConsoleUrl(favorite.url) === normalized)) {
      throw new Error("当前页面已经收藏");
    }
    const favorite: Favorite = {
      id: this.id(),
      name: name.trim(),
      product: target.product,
      regionId: target.regionId,
      url: tab.url,
      createdAt: this.now(),
    };
    this.snapshot = { ...this.snapshot, favorites: [...this.snapshot.favorites, favorite] };
    return true;
  }

  private renameFavorite(favoriteId: string, name: string): boolean {
    const favorite = this.snapshot.favorites.find((candidate) => candidate.id === favoriteId);
    if (!favorite) throw new Error("收藏不存在");
    if (favorite.name === name.trim()) return false;
    this.snapshot = {
      ...this.snapshot,
      favorites: this.snapshot.favorites.map((candidate) =>
        candidate.id === favoriteId ? { ...candidate, name: name.trim() } : candidate,
      ),
    };
    return true;
  }

  private moveFavorite(favoriteId: string, toIndex: number): boolean {
    const favorites = this.moveById(this.snapshot.favorites, favoriteId, toIndex, "收藏不存在", "收藏目标位置无效");
    if (favorites === this.snapshot.favorites) return false;
    this.snapshot = { ...this.snapshot, favorites };
    return true;
  }

  private removeFavorite(favoriteId: string): boolean {
    const index = this.snapshot.favorites.findIndex((candidate) => candidate.id === favoriteId);
    if (index < 0) return false;
    const favorite = this.snapshot.favorites[index];
    this.removedFavorite = { favorite, index };
    this.snapshot = {
      ...this.snapshot,
      favorites: this.snapshot.favorites.filter((favorite) => favorite.id !== favoriteId),
    };
    return true;
  }

  private restoreFavorite(favoriteId: string): boolean {
    const removed = this.removedFavorite;
    if (!removed || removed.favorite.id !== favoriteId) throw new Error("该收藏已无法撤销");
    const { favorite, index } = removed;
    if (
      this.snapshot.favorites.some(
        (candidate) =>
          candidate.id === favorite.id
          || normalizeConsoleUrl(candidate.url) === normalizeConsoleUrl(favorite.url),
      )
    ) {
      this.removedFavorite = null;
      throw new Error("当前页面已经收藏");
    }
    this.removedFavorite = null;
    this.snapshot = {
      ...this.snapshot,
      favorites: this.insertAt(this.snapshot.favorites, favorite, index),
    };
    return true;
  }

  private addModuleShortcut(tabId: string, name: string): boolean {
    const tab = this.snapshot.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error("标签页不存在");
    if (tab.isAuthenticating) throw new Error("登录页面不能保存快捷入口");
    if (tab.product !== "codeup" && tab.product !== "sls") {
      throw new Error("仅 Codeup 和 SLS 页面可保存快捷入口");
    }
    const target = parseConsoleTarget(tab.url);
    if (!target || target.product !== tab.product) throw new Error("当前页面无法保存快捷入口");
    const normalized = normalizeConsoleUrl(tab.url);
    if (this.snapshot.moduleShortcuts.some((shortcut) => normalizeConsoleUrl(shortcut.url) === normalized)) {
      throw new Error("当前页面已经保存为快捷入口");
    }
    const shortcut: ModuleShortcut = {
      id: this.id(),
      name: name.trim(),
      product: tab.product,
      url: tab.url,
      createdAt: this.now(),
    };
    this.snapshot = { ...this.snapshot, moduleShortcuts: [...this.snapshot.moduleShortcuts, shortcut] };
    return true;
  }

  private renameModuleShortcut(shortcutId: string, name: string): boolean {
    const shortcut = this.snapshot.moduleShortcuts.find((candidate) => candidate.id === shortcutId);
    if (!shortcut) throw new Error("快捷入口不存在");
    if (shortcut.name === name.trim()) return false;
    this.snapshot = {
      ...this.snapshot,
      moduleShortcuts: this.snapshot.moduleShortcuts.map((candidate) =>
        candidate.id === shortcutId ? { ...candidate, name: name.trim() } : candidate,
      ),
    };
    return true;
  }

  private moveModuleShortcut(shortcutId: string, toIndex: number): boolean {
    const moduleShortcuts = this.moveById(
      this.snapshot.moduleShortcuts,
      shortcutId,
      toIndex,
      "快捷入口不存在",
      "快捷入口目标位置无效",
    );
    if (moduleShortcuts === this.snapshot.moduleShortcuts) return false;
    this.snapshot = { ...this.snapshot, moduleShortcuts };
    return true;
  }

  private removeModuleShortcut(shortcutId: string): boolean {
    const index = this.snapshot.moduleShortcuts.findIndex((shortcut) => shortcut.id === shortcutId);
    if (index < 0) return false;
    const shortcut = this.snapshot.moduleShortcuts[index];
    this.removedModuleShortcut = { shortcut, index };
    this.snapshot = {
      ...this.snapshot,
      moduleShortcuts: this.snapshot.moduleShortcuts.filter((shortcut) => shortcut.id !== shortcutId),
    };
    return true;
  }

  private restoreModuleShortcut(shortcutId: string): boolean {
    const removed = this.removedModuleShortcut;
    if (!removed || removed.shortcut.id !== shortcutId) throw new Error("该快捷入口已无法撤销");
    const { shortcut, index } = removed;
    if (
      this.snapshot.moduleShortcuts.some(
        (candidate) =>
          candidate.id === shortcut.id
          || normalizeConsoleUrl(candidate.url) === normalizeConsoleUrl(shortcut.url),
      )
    ) {
      this.removedModuleShortcut = null;
      throw new Error("当前页面已经保存为快捷入口");
    }
    this.removedModuleShortcut = null;
    this.snapshot = {
      ...this.snapshot,
      moduleShortcuts: this.insertAt(this.snapshot.moduleShortcuts, shortcut, index),
    };
    return true;
  }

  private moveById<T extends { id: string }>(
    items: T[],
    id: string,
    toIndex: number,
    missingMessage: string,
    invalidTargetMessage: string,
  ): T[] {
    const fromIndex = items.findIndex((item) => item.id === id);
    if (fromIndex < 0) throw new Error(missingMessage);
    if (toIndex >= items.length) throw new Error(invalidTargetMessage);
    if (fromIndex === toIndex) return items;
    const moved = [...items];
    const [item] = moved.splice(fromIndex, 1);
    moved.splice(toIndex, 0, item);
    return moved;
  }

  private insertAt<T>(items: readonly T[], item: T, index: number): T[] {
    const next = [...items];
    next.splice(Math.min(index, next.length), 0, item);
    return next;
  }

  private validateRegionIds(regionIds: string[], allowEmpty = false): string[] {
    const unique = [...new Set(regionIds)];
    if ((!allowEmpty && unique.length === 0) || unique.some((regionId) => !isKnownRegion(regionId))) {
      throw new Error("请选择有效地域");
    }
    return unique;
  }

  private validateProductRegionIds(productRegionIds: ProductRegionIds): ProductRegionIds {
    const validated: ProductRegionIds = {
      ack: this.validateRegionIds(productRegionIds.ack, true),
      kafka: this.validateRegionIds(productRegionIds.kafka, true),
      mse: [...new Set(productRegionIds.mse)],
    };
    if (validated.mse.some((regionId) => !isProductAvailableInRegion("mse", regionId))) {
      throw new Error("MSE 仅支持北京和上海，请至少选择其中一个地域");
    }
    return validated;
  }

  private validateProducts(products: ConfigurableProduct[]): ConfigurableProduct[] {
    const unique = [...new Set(products)];
    if (unique.length === 0) throw new Error("请至少选择一个产品模块");
    return unique;
  }

  private ensureSelectedProductsHaveRegions(
    products: readonly Product[],
    productRegionIds: ProductRegionIds,
  ): void {
    for (const product of REGIONAL_PRODUCTS) {
      if (!products.includes(product)) continue;
      if (getProductRegionIds(product, productRegionIds).length > 0) continue;
      throw new Error(this.emptyProductRegionMessage(product));
    }
  }

  private emptyProductRegionMessage(product: RegionalProduct): string {
    return product === "mse"
      ? "MSE 仅支持北京和上海，请至少选择其中一个地域"
      : `${productLabel(product)} 请至少选择一个地域`;
  }

  private ensureProductRegion(
    product: WorkspaceTab["product"],
    regionId: string | null,
  ): void {
    if (!isRegionalProduct(product)) {
      if (regionId !== null) throw new Error(`${productLabel(product)} 不使用地域`);
      return;
    }
    if (
      !regionId
      || !isKnownRegion(regionId)
      || !isProductAvailableInRegion(product, regionId)
    ) throw new Error(`${productLabel(product)} 在该地域不可用`);
  }

  private restoreConsoleUrl(tab: WorkspaceTab): string {
    try {
      const url = new URL(tab.url);
      return isAllowedAuthHost(url.hostname)
        ? tab.product === "aliyun" ? CONSOLE_HOME_URL : buildConsoleEntryUrl(tab.product, tab.regionId)
        : tab.url;
    } catch {
      return tab.url;
    }
  }

  private isValidRecentVisit(visit: RecentVisit): boolean {
    const target = parseObservedConsoleTarget(visit.url, this.dependencies.allowTestServer);
    if (
      !target
      || target.product !== visit.product
      || target.regionId !== visit.regionId
    ) return false;
    if (!isRegionalProduct(visit.product)) return visit.regionId === null;
    return Boolean(
      visit.regionId
      && isKnownRegion(visit.regionId)
      && isProductAvailableInRegion(visit.product, visit.regionId),
    );
  }

  private upsertRecentVisit(tab: WorkspaceTab, visitedAt = this.now()): void {
    const visit: RecentVisit = {
      product: tab.product,
      regionId: tab.regionId,
      url: tab.url,
      title: tab.title,
      visitedAt,
    };
    if (tab.isAuthenticating || tab.externalHostname || !this.isValidRecentVisit(visit)) return;
    const normalized = normalizeConsoleUrl(visit.url);
    this.snapshot = {
      ...this.snapshot,
      recentVisits: [
        visit,
        ...this.snapshot.recentVisits.filter(
          (candidate) => normalizeConsoleUrl(candidate.url) !== normalized,
        ),
      ].slice(0, MAX_RECENT_VISITS),
    };
  }

  private isAuthenticationUrl(urlValue: string): boolean {
    try {
      return isAllowedAuthHost(new URL(urlValue).hostname);
    } catch {
      return false;
    }
  }

  private emit(): void {
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
    if (this.listeners.size === 0) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private scheduleBroadcast(): void {
    if (this.broadcastTimer || this.listeners.size === 0) return;
    this.broadcastTimer = setTimeout(() => this.emit(), 16);
    this.broadcastTimer.unref();
  }

  private getDurableSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
    const resetRuntimeState = (tab: WorkspaceTab): WorkspaceTab => ({
      ...tab,
      url: this.restoreConsoleUrl(tab),
      loadState: "deferred",
      canGoBack: false,
      canGoForward: false,
      isAuthenticating: false,
      externalHostname: undefined,
      errorMessage: undefined,
    });
    return {
      ...snapshot,
      tabs: snapshot.tabs.map(resetRuntimeState),
      recentlyClosedTabs: snapshot.recentlyClosedTabs.map(resetRuntimeState),
      notice: null,
    };
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    // Bound the delay from the first change so continuous tab switching cannot starve persistence.
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush().catch(() => undefined);
    }, 250);
    this.saveTimer.unref();
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.scheduledSave) return this.scheduledSave;
    const save = this.saveQueue.then(async () => {
      this.scheduledSave = null;
      const snapshot = this.dirtySnapshot;
      if (!snapshot) return;
      await this.dependencies.store.save(structuredClone(snapshot));
      this.saveFailed = false;
      if (this.dirtySnapshot === snapshot) this.dirtySnapshot = null;
    }).catch(() => {
      this.saveFailed = true;
      this.snapshot = { ...this.snapshot, notice: "本地状态保存失败，本次操作可能无法恢复" };
      this.emit();
      throw new Error("本地状态保存失败");
    });
    this.scheduledSave = save;
    this.saveQueue = save.catch(() => undefined);
    await save;
  }

  private success(): WorkspaceResult {
    return { ok: true };
  }

  private failure(error: string): WorkspaceResult {
    return { ok: false, error };
  }
}
