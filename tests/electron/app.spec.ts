import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AppAppearance, OpsDockApi } from "../../src/shared/api";

import {
  WORKSPACE_SCHEMA_VERSION,
  type TaskStatus,
  type WorkspaceCommand,
  type WorkspaceResult,
  type WorkspaceSnapshot,
  type WorkspaceTab,
} from "../../src/shared/model";
import { PRODUCTS } from "../../src/shared/workspace-display";
import {
  startFakeConsole,
  type FakeConsoleServer,
} from "./fake-console";

const MAIN_ENTRY = resolve("out/main/index.js");
const TEST_REGION_IDS = ["cn-beijing", "cn-shanghai"] as const;

interface ViewInfo {
  bounds: { x: number; y: number; width: number; height: number };
  id: number;
  url: string;
  visible: boolean;
}

interface StorageProbe {
  cacheKeys: string[];
  cookie: string;
  databaseNames: string[];
  localStorageValue: string | null;
  serviceWorkerCount: number;
}

function tab(
  id: string,
  product: WorkspaceTab["product"],
  regionId: string | null,
  url: string,
  lastActiveAt: number,
  options: { pinned?: boolean; taskStatus?: TaskStatus | null } = {},
): WorkspaceTab {
  return {
    id,
    product,
    regionId,
    url,
    title: `${product.toUpperCase()} fake console`,
    createdAt: lastActiveAt,
    lastActiveAt,
    pinned: options.pinned ?? false,
    taskStatus: options.taskStatus ?? null,
    loadState: "deferred",
    canGoBack: false,
    canGoForward: false,
  };
}

function configuredSnapshot(
  tabs: WorkspaceTab[] = [],
  activeTabId: string | null = null,
): WorkspaceSnapshot {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    tabs,
    activeTabId,
    favorites: [],
    moduleShortcuts: [],
    recentVisits: [],
    selectedProducts: [...PRODUCTS],
    productRegionIds: {
      ack: [...TEST_REGION_IDS],
      kafka: [...TEST_REGION_IDS],
      mse: [...TEST_REGION_IDS],
    },
    recentlyClosedTabs: [],
    sidebarCollapsed: false,
    onboardingComplete: true,
    productFilter: "all",
    taskFilter: "all",
    windowBounds: { width: 1280, height: 800 },
    notice: null,
  };
}

async function createUserData(
  snapshot?: WorkspaceSnapshot,
): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), "opsdock-e2e-"));
  if (snapshot) {
    await fs.writeFile(
      join(directory, "workspace.json"),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  return directory;
}

async function launchApp(userData: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      OPSDOCK_DEVTOOLS: "0",
      OPSDOCK_E2E_USER_DATA: userData,
    },
  });
}

async function closeApp(application: ElectronApplication | null): Promise<void> {
  if (!application) return;
  const process = application.process();
  if (process.exitCode !== null || process.signalCode !== null) return;
  const closed = application.waitForEvent("close", { timeout: 10_000 });
  await application.close();
  await closed;
}

async function getWorkspace(page: Page): Promise<WorkspaceSnapshot> {
  return page.evaluate(() =>
    (
      window as typeof window & {
        opsdock: { getWorkspace(): Promise<WorkspaceSnapshot> };
      }
    ).opsdock.getWorkspace(),
  );
}

async function selectNativeMenu(application: ElectronApplication, page: Page, label: string | null, button = "更多操作") {
  await application.evaluate(({ Menu }, selectedLabel) => {
    const popup = Menu.prototype.popup;
    Menu.prototype.popup = function (options) {
      Menu.prototype.popup = popup;
      Reflect.set(globalThis, "opsdockTestMenu", this.items.map((item) => ({ label: item.label, enabled: item.enabled })));
      if (selectedLabel) {
        const selected = this.items.find((item) => item.label === selectedLabel);
        if (!selected?.enabled) throw new Error(`Menu action unavailable: ${selectedLabel}`);
        selected.click(selected, options?.window, {} as Electron.KeyboardEvent);
      }
      options?.callback?.();
    };
  }, label);
  await page.getByRole("button", { name: button, exact: true }).click();
  return application.evaluate(() => Reflect.get(globalThis, "opsdockTestMenu") as Array<{ label: string; enabled: boolean }>);
}

async function dispatch(
  page: Page,
  command: WorkspaceCommand,
): Promise<WorkspaceResult> {
  return page.evaluate(
    (input) =>
      (
        window as typeof window & {
          opsdock: {
            dispatch(command: WorkspaceCommand): Promise<WorkspaceResult>;
          };
        }
      ).opsdock.dispatch(input),
    command,
  );
}

async function getViewTree(application: ElectronApplication): Promise<ViewInfo[]> {
  return application.evaluate(({ BrowserWindow, WebContentsView }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return [];
    return window.contentView.children.flatMap((view) => {
      if (!(view instanceof WebContentsView) || view.webContents.isDestroyed()) {
        return [];
      }
      return [{
        bounds: view.getBounds(),
        id: view.webContents.id,
        url: view.webContents.getURL(),
        visible: view.getVisible(),
      }];
    });
  });
}

async function executeInView<T>(
  application: ElectronApplication,
  urlPrefix: string,
  source: string,
): Promise<T> {
  return application.evaluate(
    async ({ webContents }, input) => {
      const target = webContents
        .getAllWebContents()
        .find(
          (contents) =>
            !contents.isDestroyed() && contents.getURL().startsWith(input.urlPrefix),
        );
      if (!target) throw new Error(`Remote WebContents not found: ${input.urlPrefix}`);
      return target.executeJavaScript(input.source, true) as Promise<T>;
    },
    { source, urlPrefix },
  );
}

async function sendShortcutInView(
  application: ElectronApplication,
  urlPrefix: string,
  keyCode: string,
  modifiers: Array<"meta" | "control" | "alt" | "shift">,
): Promise<void> {
  await application.evaluate(
    ({ webContents }, input) => {
      const target = webContents
        .getAllWebContents()
        .find(
          (contents) =>
            !contents.isDestroyed() && contents.getURL().startsWith(input.urlPrefix),
        );
      if (!target) throw new Error(`Remote WebContents not found: ${input.urlPrefix}`);
      target.focus();
      target.sendInputEvent({
        type: "keyDown",
        keyCode: input.keyCode,
        modifiers: input.modifiers,
      });
    },
    { keyCode, modifiers, urlPrefix },
  );
}

async function waitForView(
  application: ElectronApplication,
  urlPrefix: string,
): Promise<void> {
  await expect
    .poll(async () =>
      (await getViewTree(application)).some((view) =>
        view.url.startsWith(urlPrefix),
      ),
    )
    .toBe(true);
}

async function storageProbe(
  application: ElectronApplication,
  urlPrefix: string,
): Promise<StorageProbe> {
  return executeInView<StorageProbe>(
    application,
    urlPrefix,
    `void 0; (async () => ({
      cacheKeys: await caches.keys(),
      cookie: document.cookie,
      databaseNames: (await indexedDB.databases()).map((database) => database.name).filter(Boolean),
      localStorageValue: localStorage.getItem("opsdock-e2e"),
      serviceWorkerCount: (await navigator.serviceWorker.getRegistrations()).length,
    }))()`,
  );
}

let fakeConsole: FakeConsoleServer;

test.beforeAll(async () => {
  fakeConsole = await startFakeConsole();
});

test.afterAll(async () => {
  await fakeConsole?.close();
});

test("shows first-launch onboarding in a constrained single window", async () => {
  const userData = await createUserData();
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();

    await expect(page).toHaveTitle("CloudDock");
    expect(page.url()).toBe("app://renderer/index.html");
    expect(
      await page.evaluate(async () => {
        const response = await fetch("app://renderer/%2e%2e/main/index.js");
        return response.status;
      }),
    ).toBe(404);
    await expect(page.getByRole("heading", { name: "CloudDock" })).toBeVisible();
    await expect(page.getByText("选择需要的产品模块、地域和首次打开的控制台。")).toBeVisible();
    await expect(page.getByRole("button", { name: "开始使用" })).toBeVisible();
    await expect(page.locator(".product-option input")).toHaveCount(PRODUCTS.length);

    const windowState = await application.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Main window not found");
      return {
        bounds: window.getBounds(),
        contentBounds: window.getContentBounds(),
        minimumSize: window.getMinimumSize(),
        platform: process.platform,
        windowCount: BrowserWindow.getAllWindows().length,
        workArea: screen.getDisplayMatching(window.getBounds()).workArea,
      };
    });
    expect(windowState.windowCount).toBe(1);
    expect(windowState.minimumSize).toEqual([1024, 680]);
    if (windowState.platform === "darwin") {
      expect(windowState.contentBounds.height).toBe(windowState.bounds.height);
    }
    expect(windowState.bounds.width).toBe(
      Math.min(1280, windowState.workArea.width),
    );
    expect(windowState.bounds.height).toBe(
      Math.min(800, windowState.workArea.height),
    );
    expect(await getViewTree(application)).toEqual([]);

    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Main window not found");
      window.setSize(1024, 680);
    });
    await page.waitForFunction(() => window.innerWidth === 1024 && window.innerHeight <= 680);
    const onboardingLayout = await page.evaluate(() => {
      const panel = document.querySelector(".onboarding-panel");
      const submit = document.querySelector(".onboarding-panel > .primary-button");
      const regionGrid = document.querySelector(".onboarding-panel .region-grid");
      if (
        !(panel instanceof HTMLElement)
        || !(submit instanceof HTMLElement)
        || !(regionGrid instanceof HTMLElement)
      ) {
        throw new Error("Missing onboarding layout elements");
      }
      const panelBounds = panel.getBoundingClientRect();
      const submitBounds = submit.getBoundingClientRect();
      return {
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
        pageScrollHeight: document.documentElement.scrollHeight,
        pageScrollWidth: document.documentElement.scrollWidth,
        panel: {
          bottom: panelBounds.bottom,
          clientHeight: panel.clientHeight,
          left: panelBounds.left,
          overflowY: getComputedStyle(panel).overflowY,
          right: panelBounds.right,
          scrollHeight: panel.scrollHeight,
          top: panelBounds.top,
        },
        regionGrid: {
          clientHeight: regionGrid.clientHeight,
          overflowY: getComputedStyle(regionGrid).overflowY,
          scrollHeight: regionGrid.scrollHeight,
        },
        submit: {
          bottom: submitBounds.bottom,
          top: submitBounds.top,
        },
      };
    });
    expect(onboardingLayout.pageScrollWidth).toBe(onboardingLayout.innerWidth);
    expect(onboardingLayout.pageScrollHeight).toBe(onboardingLayout.innerHeight);
    expect(onboardingLayout.panel.left).toBeGreaterThanOrEqual(0);
    expect(onboardingLayout.panel.top).toBeGreaterThanOrEqual(0);
    expect(onboardingLayout.panel.right).toBeLessThanOrEqual(onboardingLayout.innerWidth);
    expect(onboardingLayout.panel.bottom).toBeLessThanOrEqual(onboardingLayout.innerHeight);
    expect(onboardingLayout.panel.overflowY).toBe("auto");
    expect(onboardingLayout.panel.scrollHeight).toBeGreaterThanOrEqual(
      onboardingLayout.panel.clientHeight,
    );
    expect(onboardingLayout.regionGrid.overflowY).toBe("auto");
    expect(onboardingLayout.regionGrid.scrollHeight).toBeGreaterThan(
      onboardingLayout.regionGrid.clientHeight,
    );
    expect(onboardingLayout.submit.top).toBeGreaterThanOrEqual(onboardingLayout.panel.top);
    expect(onboardingLayout.submit.bottom).toBeLessThanOrEqual(onboardingLayout.panel.bottom);
    await expect(page.getByRole("button", { name: "开始使用" })).toBeVisible();

    for (const product of PRODUCTS) {
      await page.locator(`.product-option[data-product="${product}"] .product-option-toggle`).click();
    }
    await expect(page.getByRole("button", { name: "开始使用" })).toBeDisabled();
    const mseCard = page.locator('.product-option[data-product="mse"] .product-option-main');
    await mseCard.click();
    await expect(page.getByRole("checkbox", { name: "MSE 模块" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /^MSE · / })).toHaveCount(2);
    await expect(mseCard).toHaveAttribute("aria-pressed", "true");
    await expect(mseCard).toContainText("1 个地域");
    await expect(page.getByRole("checkbox", { name: "MSE · 华北 2（北京）" })).toBeDisabled();

    const shellUrl = page.url();
    await page.evaluate((target) => {
      location.href = target;
    }, `${fakeConsole.baseUrl}/ack?region=cn-beijing`);
    await expect.poll(() => page.url()).toBe(shellUrl);
    expect(
      await page.evaluate((target) => window.open(target, "_blank") === null, fakeConsole.baseUrl),
    ).toBe(true);
    expect(
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    ).toBe(1);

    const forgedIpcResult = await application.evaluate(
      async ({ BrowserWindow, WebContentsView }, channel) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) throw new Error("Main window not found");
        const probe = new WebContentsView({
          webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
          },
        });
        window.contentView.addChildView(probe);
        probe.setVisible(false);
        try {
          await probe.webContents.loadURL("data:text/html,<title>untrusted-ipc-probe</title>");
          return await probe.webContents.executeJavaScript(
            `require("electron").ipcRenderer.invoke(${JSON.stringify(channel)})
              .then(() => "allowed", (error) => String(error && error.message || error))`,
            true,
          );
        } finally {
          probe.webContents.close({ waitForBeforeUnload: false });
          if (!window.isDestroyed()) window.contentView.removeChildView(probe);
        }
      },
      "app:version",
    );
    expect(forgedIpcResult).toContain("拒绝未授权的应用调用");
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("persists managed modules and filters product entry surfaces", async () => {
  const userData = await createUserData(configuredSnapshot());
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    let page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();

    const moreButton = page.getByRole("button", { name: "更多操作", exact: true });
    const moreTooltip = moreButton.locator("..");
    await moreButton.focus();
    await expect(moreButton).toHaveAttribute("aria-haspopup", "menu");
    await expect.poll(() => moreTooltip.evaluate((anchor) =>
      getComputedStyle(anchor, "::after").opacity)).toBe("1");
    await expect(moreTooltip).toHaveAttribute("data-tooltip", "更多操作：账号密码、诊断与退出登录");
    expect(await moreTooltip.evaluate((anchor) =>
      getComputedStyle(anchor, "::after").right)).toBe("0px");

    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Main window not found");
      window.setSize(1024, 680);
    });
    await page.waitForFunction(() => window.innerWidth === 1024 && window.innerHeight <= 680);
    await page.getByRole("button", { name: "管理模块" }).click();
    const settings = page.getByRole("dialog", { name: "管理模块" });
    const settingsLayout = await settings.evaluate((dialog) => {
      const body = dialog.querySelector(".modal-body");
      const save = dialog.querySelector(".primary-button");
      if (!(body instanceof HTMLElement) || !(save instanceof HTMLElement)) {
        throw new Error("Missing module settings layout elements");
      }
      const dialogBounds = dialog.getBoundingClientRect();
      const saveBounds = save.getBoundingClientRect();
      return {
        body: {
          clientHeight: body.clientHeight,
          overflowY: getComputedStyle(body).overflowY,
          scrollHeight: body.scrollHeight,
        },
        dialog: {
          bottom: dialogBounds.bottom,
          height: dialogBounds.height,
          left: dialogBounds.left,
          right: dialogBounds.right,
          top: dialogBounds.top,
          width: dialogBounds.width,
        },
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
        pageScrollHeight: document.documentElement.scrollHeight,
        pageScrollWidth: document.documentElement.scrollWidth,
        save: {
          bottom: saveBounds.bottom,
          top: saveBounds.top,
        },
      };
    });
    expect(settingsLayout.pageScrollWidth).toBe(settingsLayout.innerWidth);
    expect(settingsLayout.pageScrollHeight).toBe(settingsLayout.innerHeight);
    expect(settingsLayout.dialog.left).toBeGreaterThanOrEqual(0);
    expect(settingsLayout.dialog.top).toBeGreaterThanOrEqual(0);
    expect(settingsLayout.dialog.right).toBeLessThanOrEqual(settingsLayout.innerWidth);
    expect(settingsLayout.dialog.bottom).toBeLessThanOrEqual(settingsLayout.innerHeight);
    expect(settingsLayout.body.overflowY).toBe("auto");
    expect(settingsLayout.body.scrollHeight).toBeGreaterThanOrEqual(settingsLayout.body.clientHeight);
    expect(settingsLayout.save.top).toBeGreaterThanOrEqual(settingsLayout.dialog.top);
    expect(settingsLayout.save.bottom).toBeLessThanOrEqual(settingsLayout.dialog.bottom);
    expect(settingsLayout.dialog.height).toBe(600);
    expect(settingsLayout.dialog.width).toBe(620);
    await expect(settings.getByRole("checkbox", { name: "ACK · 中国香港" })).toBeVisible();
    await expect(settings.getByRole("button", { name: "保存" })).toBeVisible();
    const expectedSettingsSize = {
      height: settingsLayout.dialog.height,
      width: settingsLayout.dialog.width,
    };
    const readSettingsSize = () => settings.evaluate((dialog) => {
      const bounds = dialog.getBoundingClientRect();
      return { height: bounds.height, width: bounds.width };
    });

    await settings.getByRole("checkbox", { name: "ACK · 华北 2（北京）" }).locator("..").click();
    const kafkaCard = settings.locator('.product-option[data-product="kafka"] .product-option-main');
    await kafkaCard.click();
    await expect(kafkaCard).toHaveAttribute("aria-pressed", "true");
    await expect.poll(readSettingsSize).toEqual(expectedSettingsSize);
    await settings.getByRole("checkbox", { name: "Kafka · 华东 2（上海）" }).locator("..").click();
    const mseSettingsCard = settings.locator('.product-option[data-product="mse"] .product-option-main');
    await mseSettingsCard.click();
    await expect(mseSettingsCard).toHaveAttribute("aria-pressed", "true");
    await expect.poll(readSettingsSize).toEqual(expectedSettingsSize);
    await expect(settings.getByRole("checkbox", { name: /^MSE · / })).toHaveCount(2);
    await settings.getByRole("checkbox", { name: "MSE · 华北 2（北京）" }).locator("..").click();
    await settings.locator('.product-option[data-product="mse"] .product-option-toggle').click();
    await expect(settings.getByRole("status", { name: "MSE 地域配置状态" }))
      .toContainText("启用 MSE 后可选择地域。");
    await expect.poll(readSettingsSize).toEqual(expectedSettingsSize);
    await settings.locator('.product-option[data-product="mse"] .product-option-toggle').click();

    for (const product of ["dms", "codeup", "sls"] as const) {
      const card = settings.locator(`.product-option[data-product="${product}"] .product-option-main`);
      await card.click();
      await expect(card).toHaveAttribute("aria-pressed", "true");
      const label = product === "dms" ? "DMS" : product === "codeup" ? "Codeup" : "SLS";
      await expect(settings.getByRole("status", { name: `${label} 地域配置状态` }))
        .toContainText(`${label} 为全局服务。`);
      await expect.poll(readSettingsSize).toEqual(expectedSettingsSize);
    }
    for (const product of PRODUCTS.filter((product) => product !== "mse")) {
      await settings.locator(`.product-option[data-product="${product}"] .product-option-toggle`).click();
    }
    await settings.getByRole("button", { name: "保存" }).click();
    await expect(settings).not.toBeVisible();
    await expect.poll(async () => (await getWorkspace(page)).selectedProducts).toEqual(["mse"]);
    await expect.poll(async () => (await getWorkspace(page)).productRegionIds).toEqual({
      ack: ["cn-shanghai"],
      kafka: ["cn-beijing"],
      mse: ["cn-shanghai"],
    });

    await expect(page.getByRole("button", { name: "常用地域" })).toHaveCount(0);
    await expect(page.locator('.sidebar section[data-product="mse"]')).toBeVisible();
    await expect(page.locator('.sidebar section[data-product="ack"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "MSE · 上海" })).toBeVisible();
    await expect(page.getByRole("button", { name: "MSE · 北京" })).toHaveCount(0);
    await expect(page.locator(".entry-groups")).toHaveCount(0);

    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Main window not found");
      window.setSize(1280, 800);
    });
    await page.getByRole("button", { name: "快速切换" }).click();
    const palette = page.getByRole("dialog", { name: "快速切换" });
    await expect(palette.locator('[cmdk-item][data-product="mse"]')).toHaveCount(1);
    await expect(palette.locator('[cmdk-item][data-product]:not([data-product="mse"])')).toHaveCount(0);
    await page.keyboard.press("Escape");

    const readAppearance = () => page.evaluate(async () => {
      const rootStyle = getComputedStyle(document.documentElement);
      const sidebar = document.querySelector(".sidebar");
      const chrome = document.querySelector(".workspace-chrome");
      const workspace = document.querySelector(".workspace");
      if (!(sidebar instanceof HTMLElement) || !(chrome instanceof HTMLElement) || !(workspace instanceof HTMLElement)) {
        throw new Error("Missing shell appearance elements");
      }
      const appearance = await (
        window as typeof window & {
          opsdock: { getAppearance(): Promise<AppAppearance> };
        }
      ).opsdock.getAppearance();
      const accentProbe = document.createElement("span");
      const configuredAccentProbe = document.createElement("span");
      const spinnerProbe = document.createElement("span");
      accentProbe.style.color = "var(--accent)";
      configuredAccentProbe.style.color = appearance.accentColor ?? "AccentColor";
      spinnerProbe.className = "spin";
      document.body.append(accentProbe, configuredAccentProbe, spinnerProbe);
      const result = {
        accent: getComputedStyle(accentProbe).color,
        animationName: getComputedStyle(spinnerProbe).animationName,
        canvas: getComputedStyle(workspace).backgroundColor,
        chrome: getComputedStyle(chrome).backgroundColor,
        colorScheme: rootStyle.colorScheme,
        dataTheme: document.documentElement.dataset.theme ?? null,
        sidebar: getComputedStyle(sidebar).backgroundColor,
        configuredAccent: getComputedStyle(configuredAccentProbe).color,
        transitionDuration: getComputedStyle(sidebar).transitionDuration,
      };
      accentProbe.remove();
      configuredAccentProbe.remove();
      spinnerProbe.remove();
      return result;
    });
    await application.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    const lightAppearance = await readAppearance();
    await application.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    await expect.poll(async () => (await readAppearance()).canvas).not.toBe(lightAppearance.canvas);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const darkAppearance = await readAppearance();
    expect(darkAppearance.colorScheme).toContain("dark");
    expect(lightAppearance.dataTheme).toBe("light");
    expect(darkAppearance.dataTheme).toBe("dark");
    expect(darkAppearance.canvas).not.toBe(lightAppearance.canvas);
    expect(darkAppearance.sidebar).not.toBe(lightAppearance.sidebar);
    expect(darkAppearance.chrome).not.toBe(lightAppearance.chrome);
    expect(darkAppearance.accent).toBe(darkAppearance.configuredAccent);

    await page.evaluate(() => {
      document.documentElement.style.setProperty("--system-accent", "rgb(1, 2, 3)");
    });
    expect((await readAppearance()).accent).toBe("rgb(1, 2, 3)");
    await application.evaluate(({ nativeTheme }) => {
      nativeTheme.emit("updated");
    });
    await expect.poll(async () => {
      const appearance = await readAppearance();
      return appearance.accent === appearance.configuredAccent;
    }).toBe(true);

    await page.getByRole("button", { name: "管理模块" }).click();
    const darkSettings = page.getByRole("dialog", { name: "管理模块" });
    const darkSettingsAppearance = await darkSettings.evaluate((dialog) => {
      const option = dialog.querySelector(".product-option:not(.active)");
      if (!(option instanceof HTMLElement)) throw new Error("Missing inactive module option");
      const resolveStyle = (property: "backgroundColor" | "color", value: string) => {
        const probe = document.createElement("span");
        probe.style[property] = value;
        document.body.append(probe);
        const result = getComputedStyle(probe)[property];
        probe.remove();
        return result;
      };
      return {
        background: getComputedStyle(dialog).backgroundColor,
        color: getComputedStyle(dialog).color,
        controlBackground: resolveStyle("backgroundColor", "var(--control)"),
        optionBackground: getComputedStyle(option).backgroundColor,
        raisedBackground: resolveStyle("backgroundColor", "var(--surface-raised)"),
        textColor: resolveStyle("color", "var(--text)"),
      };
    });
    expect(darkSettingsAppearance.background).toBe(darkSettingsAppearance.raisedBackground);
    expect(darkSettingsAppearance.optionBackground).toBe(darkSettingsAppearance.controlBackground);
    expect(darkSettingsAppearance.color).toBe(darkSettingsAppearance.textColor);
    await darkSettings.getByRole("button", { name: "关闭" }).click();

    await page.getByRole("button", { name: "快速切换" }).click();
    const darkPalette = page.getByRole("dialog", { name: "快速切换" });
    await expect.poll(() => darkPalette.evaluate((dialog) => {
      const selectedItem = dialog.querySelector('[cmdk-item][data-selected="true"]');
      if (!(selectedItem instanceof HTMLElement)) return false;
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--accent-soft)";
      document.body.append(probe);
      const matches = getComputedStyle(selectedItem).backgroundColor
        === getComputedStyle(probe).backgroundColor;
      probe.remove();
      return matches;
    })).toBe(true);
    const darkPaletteAppearance = await darkPalette.evaluate((dialog) => {
      const panel = dialog.querySelector(".command-panel");
      const selectedItem = dialog.querySelector('[cmdk-item][data-selected="true"]');
      if (!(panel instanceof HTMLElement) || !(selectedItem instanceof HTMLElement)) {
        throw new Error("Missing command palette appearance elements");
      }
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--accent-soft)";
      document.body.append(probe);
      const selectedTokenBackground = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        background: getComputedStyle(panel).backgroundColor,
        color: getComputedStyle(panel).color,
        selectedBackground: getComputedStyle(selectedItem).backgroundColor,
        selectedTokenBackground,
      };
    });
    expect(darkPaletteAppearance.background).toBe(darkSettingsAppearance.background);
    expect(darkPaletteAppearance.selectedBackground).toBe(darkPaletteAppearance.selectedTokenBackground);
    expect(darkPaletteAppearance.color).toBe(darkSettingsAppearance.textColor);
    await page.keyboard.press("Escape");

    expect(darkAppearance.animationName).toBe("none");
    expect(Number.parseFloat(darkAppearance.transitionDuration)).toBeLessThanOrEqual(0.00001);
    await application.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "system";
    });

    await closeApp(application);
    application = null;
    application = await launchApp(userData);
    page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();
    expect((await getWorkspace(page)).selectedProducts).toEqual(["mse"]);
    expect((await getWorkspace(page)).productRegionIds).toEqual({
      ack: ["cn-shanghai"],
      kafka: ["cn-beijing"],
      mse: ["cn-shanghai"],
    });
    await expect(page.locator('.sidebar section[data-product="mse"]')).toBeVisible();
    await expect(page.locator('.sidebar section[data-product="ack"]')).toHaveCount(0);
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("filters hostile restored URLs and rejects hostile shell dispatches", async () => {
  const unsafe = tab("unsafe", "ack", "cn-beijing", "data:text/html,untrusted", 1);
  const snapshot = configuredSnapshot([unsafe], unsafe.id);
  snapshot.favorites.push({
    id: "unsafe-favorite",
    name: "unsafe",
    product: "ack",
    regionId: "cn-beijing",
    url: "https://example.com/untrusted",
    createdAt: 1,
  });
  const userData = await createUserData(snapshot);
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(page.getByRole("status")).toContainText("已忽略无法安全恢复的页面");
    expect(await getViewTree(application)).toEqual([]);
    expect(await getWorkspace(page)).toMatchObject({
      tabs: [],
      activeTabId: null,
      favorites: [],
    });

    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Main window not found");
      window.setSize(1024, 680);
    });
    const minimumLayout = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
        const bounds = element.getBoundingClientRect();
        return {
          bottom: bounds.bottom,
          height: bounds.height,
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          width: bounds.width,
        };
      };
      return {
        chrome: rect(".workspace-chrome"),
        emptyHeading: document.querySelector(".empty-workspace h2")?.textContent ?? null,
        entryGroupCount: document.querySelectorAll(".entry-groups").length,
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
        scrollHeight: document.documentElement.scrollHeight,
        scrollWidth: document.documentElement.scrollWidth,
        sidebar: rect(".sidebar"),
        tabBar: rect(".tab-bar"),
        toolbar: rect(".toolbar"),
        viewport: rect(".console-viewport"),
      };
    });
    expect(minimumLayout.sidebar.width).toBe(220);
    expect(minimumLayout.sidebar.right).toBeLessThanOrEqual(minimumLayout.tabBar.left);
    expect(minimumLayout.sidebar.top).toBe(minimumLayout.chrome.top);
    expect(minimumLayout.sidebar.bottom).toBeGreaterThanOrEqual(minimumLayout.viewport.bottom);
    expect(minimumLayout.tabBar.top).toBe(minimumLayout.chrome.top);
    expect(minimumLayout.tabBar.bottom).toBeLessThanOrEqual(minimumLayout.toolbar.top);
    expect(minimumLayout.toolbar.top).toBeGreaterThanOrEqual(minimumLayout.tabBar.bottom);
    expect(minimumLayout.toolbar.bottom).toBe(minimumLayout.chrome.bottom);
    expect(minimumLayout.chrome.bottom).toBeLessThanOrEqual(minimumLayout.viewport.top);
    expect(minimumLayout.viewport.width).toBeGreaterThan(0);
    expect(minimumLayout.viewport.height).toBeGreaterThan(0);
    expect(minimumLayout.scrollWidth).toBe(minimumLayout.innerWidth);
    expect(minimumLayout.scrollHeight).toBe(minimumLayout.innerHeight);
    expect(minimumLayout.emptyHeading).toBe("选择一个控制台");
    expect(minimumLayout.entryGroupCount).toBe(0);

    await page.getByRole("button", { name: "折叠侧栏" }).click();
    await expect(page.locator(".sidebar")).toHaveClass(/collapsed/);
    await expect.poll(() => page.evaluate(() => {
      const sidebar = document.querySelector(".sidebar");
      if (!(sidebar instanceof HTMLElement)) throw new Error("Missing collapsed sidebar");
      return {
        platform: document.documentElement.dataset.platform,
        sidebarWidth: sidebar.getBoundingClientRect().width,
      };
    })).toEqual({ platform: "darwin", sidebarWidth: 116 });
    const collapsedLayout = await page.evaluate(() => {
      const sidebar = document.querySelector(".sidebar");
      const toggle = document.querySelector(".sidebar-toggle");
      if (!(sidebar instanceof HTMLElement) || !(toggle instanceof HTMLElement)) {
        throw new Error("Missing collapsed sidebar elements");
      }
      const sidebarBounds = sidebar.getBoundingClientRect();
      const toggleBounds = toggle.getBoundingClientRect();
      return {
        platform: document.documentElement.dataset.platform,
        sidebarWidth: sidebarBounds.width,
        toggleLeft: toggleBounds.left,
        toggleRightGap: sidebarBounds.right - toggleBounds.right,
      };
    });
    if (collapsedLayout.platform === "darwin") {
      expect(collapsedLayout.sidebarWidth).toBe(116);
      expect(collapsedLayout.toggleLeft).toBeGreaterThanOrEqual(78);
      expect(collapsedLayout.toggleRightGap).toBeGreaterThanOrEqual(7);
    }

    const rejected = await page.evaluate(async () => {
      try {
        await (
          window as typeof window & {
            opsdock: { dispatch(command: WorkspaceCommand): Promise<WorkspaceResult> };
          }
        ).opsdock.dispatch({
          type: "open-url",
          product: "ack",
          regionId: "cn-beijing",
          url: "https://example.com/untrusted",
        });
        return "allowed";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(rejected).toContain("只允许打开受信任的阿里云控制台链接");
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("finds and scrolls between all native page matches", async ({}, testInfo) => {
  const url = `${fakeConsole.baseUrl}/ack/find?region=cn-beijing`;
  const userData = await createUserData(configuredSnapshot([tab("find", "ack", "cn-beijing", url, 1)], "find"));
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await waitForView(application, url);
    await expect.poll(() => executeInView(application!, url, "document.readyState")).toBe("complete");
    await page.getByRole("button", { name: "页内查找", exact: true }).click();
    const bar = page.getByRole("search", { name: "页内查找" });
    const input = bar.getByRole("textbox", { name: "查找内容" });
    await input.fill("定位测试");
    await expect(bar.getByRole("status")).toHaveText("1 / 3");
    const firstScroll = await executeInView<number>(application, url, "window.scrollY");
    expect(firstScroll).toBeGreaterThan(0);
    await input.press("Enter");
    await expect(bar.getByRole("status")).toHaveText("2 / 3");
    await expect.poll(() => executeInView<number>(application!, url, "window.scrollY")).toBeGreaterThan(firstScroll + 400);
    await input.press("Shift+Enter");
    await expect(bar.getByRole("status")).toHaveText("1 / 3");
    await bar.getByRole("button", { name: "上一个匹配项" }).click();
    await expect(bar.getByRole("status")).toHaveText("3 / 3");
    await bar.getByRole("button", { name: "下一个匹配项" }).click();
    await expect(bar.getByRole("status")).toHaveText("1 / 3");
    for (const width of [1280, 1024]) {
      await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]?.setSize(width, 800), width);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
      await expect.poll(async () => (await getViewTree(application!)).filter((view) => view.visible).map((view) => view.url)).toEqual([url]);
      const png = await application.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0]!.capturePage()).toPNG().toString("base64"));
      await fs.writeFile(testInfo.outputPath(`native-find-${width}.png`), Buffer.from(png, "base64"));
      const remotePng = await application.evaluate(async ({ webContents }, url) =>
        (await webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.capturePage()).toPNG().toString("base64"), url);
      await fs.writeFile(testInfo.outputPath(`remote-find-${width}.png`), Buffer.from(remotePng, "base64"));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
    await input.fill("not-present-anywhere");
    await expect(bar.getByRole("status")).toHaveText("无结果");
    await expect(bar.getByRole("button", { name: "下一个匹配项" })).toBeDisabled();
    await input.fill("");
    await expect(bar.getByRole("status")).toHaveText("");
    await input.press("Escape");
    await expect(bar).not.toBeVisible();
    await sendShortcutInView(application, url, "F", ["meta"]);
    await expect(input).toBeFocused();
  } finally {
    if (application) await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("handles app shortcuts while the remote console has focus", async ({}, testInfo) => {
  const ackUrl = `${fakeConsole.baseUrl}/ack/shortcuts?region=cn-beijing`;
  const kafkaUrl = `${fakeConsole.baseUrl}/kafka/shortcuts?region=cn-shanghai`;
  const initialTabs = [
    tab("ack-shortcuts", "ack", "cn-beijing", ackUrl, 2),
    tab("kafka-shortcuts", "kafka", "cn-shanghai", kafkaUrl, 1),
  ];
  const initialSnapshot = configuredSnapshot(initialTabs, "ack-shortcuts");
  initialSnapshot.favorites.push({
    id: "ack-shortcut-favorite",
    name: "快捷键收藏",
    product: "ack",
    regionId: "cn-beijing",
    url: ackUrl,
    createdAt: 1,
  });
  const userData = await createUserData(initialSnapshot);
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    const rendererErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") rendererErrors.push(message.text());
    });
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await expect(page.locator(".app-shell")).toBeVisible();
    await waitForView(application, ackUrl);
    await expect.poll(() => executeInView<string>(
      application!,
      ackUrl,
      `document.readyState + ":" + (document.querySelector('[data-testid="console-ready"]')?.textContent ?? "")`,
    )).toBe("complete:ready");
    await sendShortcutInView(application, ackUrl, "F", ["meta"]);
    const findBar = page.getByRole("search", { name: "页内查找" });
    await expect(findBar).toBeVisible();
    await findBar.getByRole("textbox", { name: "查找内容" }).fill("ready");
    await expect(findBar.getByRole("status")).toHaveText("1 / 1");
    await findBar.getByRole("textbox", { name: "查找内容" }).press("Enter");
    await expect(findBar.getByRole("status")).toHaveText("1 / 1");
    await findBar.getByRole("textbox", { name: "查找内容" }).press("Shift+Enter");
    await expect(findBar.getByRole("status")).toHaveText("1 / 1");
    const findLayout = await page.evaluate(() => ({
      chromeHeight: document.querySelector(".workspace-chrome")?.getBoundingClientRect().height,
      findHeight: document.querySelector(".page-find-row")?.getBoundingClientRect().height,
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(findLayout).toEqual({ chromeHeight: 112, findHeight: 34, innerWidth: 1280, scrollWidth: 1280 });
    await page.screenshot({ path: testInfo.outputPath("page-find.png") });
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1024, 680);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024);
    const narrowFindLayout = await page.evaluate(() => {
      const bar = document.querySelector(".page-find-bar")?.getBoundingClientRect();
      return {
        barRight: bar?.right,
        barWidth: bar?.width,
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    expect(narrowFindLayout.scrollWidth).toBe(narrowFindLayout.innerWidth);
    expect(narrowFindLayout.barRight).toBeLessThanOrEqual(narrowFindLayout.innerWidth);
    expect(narrowFindLayout.barWidth).toBeLessThanOrEqual(360);
    await page.screenshot({ path: testInfo.outputPath("page-find-1024.png") });
    await findBar.getByRole("textbox", { name: "查找内容" }).press("Escape");
    await expect(findBar).not.toBeVisible();
    await expect.poll(() => executeInView<string>(
      application!,
      ackUrl,
      "globalThis.getSelection()?.toString() ?? ''",
    )).toBe("");
    expect(rendererErrors).toEqual([]);

    const previousClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
    try {
      await selectNativeMenu(application, page, "复制诊断摘要");
      const diagnosticSummary = await application.evaluate(({ clipboard }) => clipboard.readText());
      expect(diagnosticSummary).toMatch(/^CloudDock \S+/);
      const electronVersion = await application.evaluate(() => process.versions.electron);
      expect(diagnosticSummary).toContain(`Electron ${electronVersion}`);
      expect(diagnosticSummary).toContain("Tabs: 2");
      expect(diagnosticSummary).not.toContain(ackUrl);
      expect(diagnosticSummary).not.toContain("ack-shortcuts");
    } finally {
      await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), previousClipboard);
    }
    await page.getByRole("button", { name: "关闭提示" }).click();

    await executeInView(
      application,
      ackUrl,
      `document.querySelector('[data-testid="navigate-detail"]').click(); true`,
    );
    const ackDetailsUrl = `${fakeConsole.baseUrl}/ack/details?region=cn-beijing`;
    await waitForView(application, ackDetailsUrl);
    // Native navigation can commit before the coalesced workspace update reaches the shell.
    await expect(page.getByRole("button", { name: "后退", exact: true })).toBeEnabled();
    await sendShortcutInView(application, ackDetailsUrl, "[", ["meta"]);
    await waitForView(application, ackUrl);
    await expect(page.getByRole("button", { name: "前进", exact: true })).toBeEnabled();
    await sendShortcutInView(application, ackUrl, "]", ["meta"]);
    await waitForView(application, ackDetailsUrl);
    await expect(page.getByRole("button", { name: "后退", exact: true })).toBeEnabled();
    await sendShortcutInView(application, ackDetailsUrl, "[", ["meta"]);
    await waitForView(application, ackUrl);

    await sendShortcutInView(application, ackUrl, "D", ["meta"]);
    await expect.poll(async () => (await getWorkspace(page)).favorites).toEqual([]);
    await expect(page.getByRole("status")).toContainText("已删除收藏“快捷键收藏”");
    await page.getByRole("button", { name: "撤销删除 快捷键收藏" }).click();
    await expect.poll(async () => (await getWorkspace(page)).favorites.map((item) => item.id)).toEqual([
      "ack-shortcut-favorite",
    ]);

    await sendShortcutInView(application, ackUrl, "Tab", ["control"]);
    await expect.poll(async () => (await getWorkspace(page)).activeTabId).toBe("kafka-shortcuts");
    await waitForView(application, kafkaUrl);

    await sendShortcutInView(application, kafkaUrl, "Tab", ["control", "shift"]);
    await expect.poll(async () => (await getWorkspace(page)).activeTabId).toBe("ack-shortcuts");

    await sendShortcutInView(application, ackUrl, "2", ["meta"]);
    await expect.poll(async () => (await getWorkspace(page)).activeTabId).toBe("kafka-shortcuts");

    await sendShortcutInView(application, kafkaUrl, "1", ["meta"]);
    await expect.poll(async () => (await getWorkspace(page)).activeTabId).toBe("ack-shortcuts");

    await sendShortcutInView(application, ackUrl, "9", ["meta"]);
    await expect.poll(async () => (await getWorkspace(page)).activeTabId).toBe("kafka-shortcuts");

    await sendShortcutInView(application, kafkaUrl, "1", ["meta"]);
    await expect.poll(async () => (await getWorkspace(page)).activeTabId).toBe("ack-shortcuts");

    const paletteClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
    try {
      const clipboardUrl = "https://codeup.aliyun.com/org/opsdock/repository/1";
      await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), clipboardUrl);
      await sendShortcutInView(application, ackUrl, "K", ["meta"]);
      await expect(page.locator(".command-panel")).toBeVisible();
      const commandInput = page.locator(".command-input-wrap input");
      await expect(commandInput).toBeFocused();
      await expect(commandInput).toHaveValue("");
      await commandInput.fill("ACK");
      await page.keyboard.press("Escape");
      await expect(page.locator(".command-panel")).not.toBeVisible();

      await sendShortcutInView(application, ackUrl, "K", ["meta"]);
      await expect(page.locator(".command-panel")).toBeVisible();
      await expect(commandInput).toBeFocused();
      await expect(commandInput).toHaveValue("");
      await page.keyboard.press("Escape");
      await expect(page.locator(".command-panel")).not.toBeVisible();

      await sendShortcutInView(application, ackUrl, "T", ["meta"]);
      await expect(page.locator(".command-panel")).toBeVisible();
      await expect(commandInput).toBeFocused();
      await expect(commandInput).toHaveValue(clipboardUrl);
      await expect(page.locator(".command-panel").getByText("打开链接", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");

      await page.locator(".command-trigger").focus();
      await page.keyboard.press("Meta+t");
      await expect(page.locator(".command-panel")).toBeVisible();
      await expect(commandInput).toHaveValue(clipboardUrl);
      await page.keyboard.press("Escape");
    } finally {
      await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), paletteClipboard);
    }

    await sendShortcutInView(application, ackUrl, "W", ["meta"]);
    await expect.poll(async () => (await getWorkspace(page)).tabs.map((item) => item.id)).toEqual([
      "kafka-shortcuts",
    ]);
    await waitForView(application, kafkaUrl);

    await sendShortcutInView(application, kafkaUrl, "T", ["meta", "shift"]);
    await expect.poll(async () => (await getWorkspace(page)).activeTabId).toBe("ack-shortcuts");
    expect((await getWorkspace(page)).tabs.map((item) => item.id)).toEqual([
      "kafka-shortcuts",
      "ack-shortcuts",
    ]);
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("persists tab task metadata and recent visits across restart", async () => {
  const ackUrl = `${fakeConsole.baseUrl}/ack/task-metadata?region=cn-beijing`;
  const otherAckUrl = `${fakeConsole.baseUrl}/ack/other-task?region=cn-beijing`;
  const kafkaUrl = `${fakeConsole.baseUrl}/kafka/task-metadata?region=cn-shanghai`;
  const initialTabs = [
    tab("ack-task", "ack", "cn-beijing", ackUrl, 2),
    tab("ack-other", "ack", "cn-beijing", otherAckUrl, 0),
    tab("kafka-task", "kafka", "cn-shanghai", kafkaUrl, 1),
  ];
  const initialSnapshot = configuredSnapshot(initialTabs, "ack-task");
  initialSnapshot.favorites.push({
    id: "layout-favorite",
    name: "生产环境超长收藏名称用于布局检查",
    product: "ack",
    regionId: "cn-beijing",
    url: `${fakeConsole.baseUrl}/ack/layout-favorite?region=cn-beijing`,
    createdAt: 1,
  });
  initialSnapshot.moduleShortcuts.push({
    id: "layout-shortcut",
    name: "示例应用仓库",
    product: "codeup",
    url: "https://codeup.aliyun.com/org/opsdock/repository/layout-shortcut",
    createdAt: 2,
  });
  const userData = await createUserData(initialSnapshot);
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    let page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();
    await waitForView(application, ackUrl);

    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Main window not found");
      window.setSize(1024, 680);
    });
    await page.waitForFunction(() => window.innerWidth === 1024 && window.innerHeight <= 680);
    const shortcutActionLayout = await page.evaluate(() => {
      const shortcut = document.querySelector(".module-shortcut-row .favorite-main");
      const label = shortcut?.querySelector("span");
      const actions = document.querySelector(".module-shortcut-row .favorite-actions");
      if (!(label instanceof HTMLElement) || !(actions instanceof HTMLElement)) throw new Error("Missing shortcut actions");
      return {
        labelRight: label.getBoundingClientRect().right,
        actionsLeft: actions.getBoundingClientRect().left,
        buttonCount: actions.querySelectorAll("button").length,
      };
    });
    expect(shortcutActionLayout.labelRight).toBeLessThanOrEqual(shortcutActionLayout.actionsLeft);
    expect(shortcutActionLayout.buttonCount).toBe(1);

    const favoriteRow = page.locator(".favorites-section .favorite-row").filter({
      has: page.getByRole("button", { name: "生产环境超长收藏名称用于布局检查" }),
    });
    await favoriteRow.hover();
    const sidebarActionLayout = await favoriteRow.evaluate((row) => {
      const label = row.querySelector(".favorite-main span");
      const actions = row.querySelector(".favorite-actions");
      if (!(label instanceof HTMLElement) || !(actions instanceof HTMLElement)) {
        throw new Error("Missing favorite row layout elements");
      }
      const labelBounds = label.getBoundingClientRect();
      const actionBounds = actions.getBoundingClientRect();
      return {
        actionLeft: actionBounds.left,
        labelRight: labelBounds.right,
      };
    });
    expect(sidebarActionLayout.labelRight).toBeLessThanOrEqual(sidebarActionLayout.actionLeft);

    const tabActionLayout = await page.evaluate(() => {
      const taskFilter = document.querySelector(".tab-task-filter");
      const history = document.querySelector(".tab-action");
      if (!(taskFilter instanceof HTMLElement) || !(history instanceof HTMLElement)) {
        throw new Error("Missing tab action layout elements");
      }
      const filterBounds = taskFilter.getBoundingClientRect();
      const historyBounds = history.getBoundingClientRect();
      return {
        filterHeight: filterBounds.height,
        filterTop: filterBounds.top,
        historyHeight: historyBounds.height,
        historyTop: historyBounds.top,
      };
    });
    expect(tabActionLayout.historyHeight).toBe(tabActionLayout.filterHeight);
    expect(tabActionLayout.historyTop).toBe(tabActionLayout.filterTop);

    const ackTab = page.locator(".tab").filter({ has: page.locator("#workspace-tab-ack-task") });
    await ackTab.locator(".tab-pin").click();
    await expect.poll(async () =>
      (await getWorkspace(page)).tabs.find((current) => current.id === "ack-task")?.pinned,
    ).toBe(true);
    await ackTab.locator(".tab-task-status").click();
    await expect.poll(async () =>
      (await getWorkspace(page)).tabs.find((current) => current.id === "ack-task")?.taskStatus,
    ).toBe("todo");
    await ackTab.locator(".tab-task-status").click();
    await expect.poll(async () =>
      (await getWorkspace(page)).tabs.find((current) => current.id === "ack-task")?.taskStatus,
    ).toBe("doing");

    await page.getByRole("combobox", { name: "按产品筛选标签" }).selectOption("kafka");
    await expect(page.locator("#workspace-tab-ack-task")).toBeVisible();
    await expect(page.locator("#workspace-tab-ack-other")).toHaveCount(0);
    await expect(page.locator("#workspace-tab-kafka-task")).toBeVisible();
    await page.locator("#workspace-tab-kafka-task").click();
    await expect.poll(async () => (await getWorkspace(page)).activeTabId).toBe("kafka-task");
    await expect(page.locator("#workspace-tab-ack-task")).toHaveCount(0);
    await waitForView(application, kafkaUrl);
    expect((await dispatch(page, { type: "activate-tab", tabId: "ack-task" })).ok).toBe(true);

    let snapshot = await getWorkspace(page);
    expect(snapshot.tabs.find((current) => current.id === "ack-task")).toMatchObject({
      pinned: true,
      taskStatus: "doing",
    });
    expect(snapshot.recentVisits.slice(0, 2).map((visit) => ({
      product: visit.product,
      url: visit.url,
    }))).toEqual([
      { product: "ack", url: ackUrl },
      { product: "kafka", url: kafkaUrl },
    ]);

    expect((await dispatch(page, { type: "close-tab", tabId: "kafka-task" })).ok).toBe(true);
    await expect(page.getByRole("combobox", { name: "按产品筛选标签" })).toHaveCount(0);
    const previousClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
    try {
      await application.evaluate(({ clipboard }) => clipboard.writeText(""));
      await page.locator(".command-trigger").focus();
      await page.keyboard.press("Meta+k");
      await expect(page.getByText("最近访问 · Kafka")).toBeVisible();
      await expect(page.getByText("Kafka fake console", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    } finally {
      await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), previousClipboard);
    }

    expect((await dispatch(page, {
      type: "set-tab-filters",
      productFilter: "ack",
      taskFilter: "doing",
    })).ok).toBe(true);
    await expect.poll(async () => {
      const current = await getWorkspace(page);
      return [current.productFilter, current.taskFilter];
    }).toEqual(["ack", "doing"]);

    await closeApp(application);
    application = await launchApp(userData);
    page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();

    snapshot = await getWorkspace(page);
    expect(snapshot.tabs.find((current) => current.id === "ack-task")).toMatchObject({
      pinned: true,
      taskStatus: "doing",
    });
    expect(snapshot.recentVisits.slice(0, 2).map((visit) => visit.url)).toEqual([
      ackUrl,
      kafkaUrl,
    ]);
    expect(snapshot).toMatchObject({ productFilter: "ack", taskFilter: "doing" });
    await expect(page.getByRole("combobox", { name: "按产品筛选标签" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "按任务状态筛选标签" })).toHaveValue("doing");
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("reorders tabs by drag and focused keyboard without capturing remote editing keys", async () => {
  const tabs = [
    tab("reorder-1", "ack", "cn-beijing", `${fakeConsole.baseUrl}/ack/reorder-1`, 3),
    tab("reorder-2", "kafka", "cn-shanghai", `${fakeConsole.baseUrl}/kafka/reorder-2`, 2),
    tab("reorder-3", "ack", "cn-beijing", `${fakeConsole.baseUrl}/ack/reorder-3`, 1),
  ];
  const userData = await createUserData(configuredSnapshot(tabs, "reorder-1"));
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();
    await waitForView(application, tabs[0].url);

    const activeIndicator = await page.locator(".tab.active").evaluate((activeTab) => {
      const style = getComputedStyle(activeTab, "::before");
      return { content: style.content, height: style.height };
    });
    expect(activeIndicator.content).toBe("none");
    expect(activeIndicator.height).not.toBe("2px");

    await page.locator(".tab").nth(0).dragTo(page.locator(".tab").nth(2));
    await expect.poll(async () => (await getWorkspace(page)).tabs.map((item) => item.id)).toEqual([
      "reorder-2",
      "reorder-3",
      "reorder-1",
    ]);
    expect((await getWorkspace(page)).activeTabId).toBe("reorder-1");

    const movedTabButton = page.locator(".tab-main").nth(2);
    await movedTabButton.focus();
    await page.keyboard.press("Alt+Shift+ArrowLeft");
    await expect.poll(async () => (await getWorkspace(page)).tabs.map((item) => item.id)).toEqual([
      "reorder-2",
      "reorder-1",
      "reorder-3",
    ]);

    await page.keyboard.press("Control+Alt+Shift+ArrowLeft");
    expect((await getWorkspace(page)).tabs.map((item) => item.id)).toEqual([
      "reorder-2",
      "reorder-1",
      "reorder-3",
    ]);

    await executeInView(application, tabs[0].url, `(() => {
      const input = document.createElement("input");
      input.id = "remote-editor";
      input.value = "alpha beta";
      document.body.append(input);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return true;
    })()`);
    await sendShortcutInView(application, tabs[0].url, "Left", ["alt", "shift"]);
    expect((await getWorkspace(page)).tabs.map((item) => item.id)).toEqual([
      "reorder-2",
      "reorder-1",
      "reorder-3",
    ]);
    const remoteSelection = await executeInView<{ start: number; end: number }>(
      application,
      tabs[0].url,
      `(() => {
        const input = document.querySelector("#remote-editor");
        return { start: input.selectionStart, end: input.selectionEnd };
      })()`,
    );
    expect(remoteSelection.start).toBe(6);
    expect(remoteSelection.end).toBeGreaterThanOrEqual(remoteSelection.start);
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("restores views lazily and enforces remote-page boundaries", async () => {
  const ackUrl = `${fakeConsole.baseUrl}/ack`;
  const kafkaUrl = `${fakeConsole.baseUrl}/kafka`;
  const initialTabs = [
    tab("ack-restored", "ack", "cn-beijing", ackUrl, 1),
    tab("kafka-restored", "kafka", "cn-shanghai", kafkaUrl, 2),
  ];
  const userData = await createUserData(
    configuredSnapshot(initialTabs, "ack-restored"),
  );
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();

    await waitForView(application, ackUrl);
    let views = await getViewTree(application);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ url: ackUrl, visible: true });
    expect(views[0].bounds.width).toBeGreaterThan(0);
    expect(views[0].bounds.height).toBeGreaterThan(0);

    const isolation = await executeInView<{
      nodeProcess: string;
      opsdock: string;
      require: string;
    }>(
      application,
      ackUrl,
      `({
        nodeProcess: typeof process,
        opsdock: typeof window.opsdock,
        require: typeof require,
      })`,
    );
    expect(isolation).toEqual({
      nodeProcess: "undefined",
      opsdock: "undefined",
      require: "undefined",
    });

    const activation = await dispatch(page, {
      type: "activate-tab",
      tabId: "kafka-restored",
    });
    expect(activation.ok).toBe(true);
    await waitForView(application, kafkaUrl);
    await expect
      .poll(async () =>
        (await getViewTree(application!)).filter((view) => view.visible).map((view) => view.url),
      )
      .toEqual([kafkaUrl]);
    views = await getViewTree(application);
    expect(views).toHaveLength(2);

    const detailsUrl = `${fakeConsole.baseUrl}/ack/details`;
    const opened = await dispatch(page, {
      type: "open-url",
      product: "ack",
      regionId: "cn-beijing",
      url: detailsUrl,
      title: "ACK details",
    });
    expect(opened.ok).toBe(true);
    await waitForView(application, detailsUrl);
    await expect
      .poll(async () =>
        (await getViewTree(application!)).filter((view) => view.visible).map((view) => view.url),
      )
      .toEqual([detailsUrl]);

    await executeInView(
      application,
      detailsUrl,
      `window.open(${JSON.stringify(`${fakeConsole.baseUrl}/popup/console`)}, "_blank"); true`,
    );
    await expect
      .poll(async () => (await getWorkspace(page)).tabs.length)
      .toBe(4);
    await expect
      .poll(() =>
        application!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().length,
        ),
      )
      .toBe(1);

    const popupSnapshot = await getWorkspace(page);
    expect(popupSnapshot.tabs.at(-1)?.url).toBe(
      `${fakeConsole.baseUrl}/popup/console`,
    );
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("restores a regional MSE view and preserves its page when reopening the region", async () => {
  const mseUrl = `${fakeConsole.baseUrl}/mse?region=cn-beijing`;
  const mseDetailsUrl = `${fakeConsole.baseUrl}/mse/details?region=cn-beijing`;
  const mseTab = tab("mse-restored", "mse", "cn-beijing", mseUrl, 1);
  const userData = await createUserData(configuredSnapshot([mseTab], mseTab.id));
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();
    await waitForView(application, mseUrl);

    await expect(page.getByRole("tab", { name: "MSE fake console · 北京" })).toBeVisible();
    await expect(page.getByRole("button", { name: "MSE · 北京" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator(".toolbar-context")).toHaveText("MSE · 北京");
    expect(
      await executeInView<{ product: string; region: string | undefined }>(
        application,
        mseUrl,
        `(() => {
          const ready = document.querySelector('[data-testid="console-ready"]');
          return { product: ready.dataset.product, region: ready.dataset.region };
        })()`,
      ),
    ).toEqual({ product: "mse", region: "cn-beijing" });

    await executeInView(
      application,
      mseUrl,
      `document.querySelector('[data-testid="navigate-detail"]').click(); true`,
    );
    await waitForView(application, mseDetailsUrl);
    await expect
      .poll(async () => {
        const current = (await getWorkspace(page)).tabs.find((item) => item.id === mseTab.id);
        return current && { product: current.product, regionId: current.regionId, url: current.url };
      })
      .toEqual({ product: "mse", regionId: "cn-beijing", url: mseDetailsUrl });

    await page.getByRole("button", { name: "MSE · 北京" }).click();
    await expect
      .poll(async () => {
        const snapshot = await getWorkspace(page);
        return {
          activeTabId: snapshot.activeTabId,
          tabs: snapshot.tabs.map((item) => ({
            product: item.product,
            regionId: item.regionId,
            url: item.url,
          })),
        };
      })
      .toEqual({
        activeTabId: mseTab.id,
        tabs: [{ product: "mse", regionId: "cn-beijing", url: mseDetailsUrl }],
      });
    await waitForView(application, mseDetailsUrl);
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("restores a regionless DMS view and deduplicates captured DMS popups", async () => {
  const dmsUrl = `${fakeConsole.baseUrl}/dms`;
  const dmsDetailsUrl = `${fakeConsole.baseUrl}/dms/details`;
  const dmsTab = tab("dms-restored", "dms", null, dmsUrl, 1);
  const userData = await createUserData(configuredSnapshot([dmsTab], dmsTab.id));
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();
    await waitForView(application, dmsUrl);

    await expect(
      page.getByRole("tab", { name: "DMS fake console", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "DMS", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator(".toolbar-context")).toHaveText("DMS");

    expect(
      await executeInView<{ hasRegion: boolean; product: string; regionRow: boolean }>(
        application,
        dmsUrl,
        `(() => {
          const ready = document.querySelector('[data-testid="console-ready"]');
          return {
            hasRegion: ready.hasAttribute('data-region'),
            product: ready.dataset.product,
            regionRow: Boolean(document.querySelector('[data-testid="console-region"]')),
          };
        })()`,
      ),
    ).toEqual({ hasRegion: false, product: "dms", regionRow: false });

    await executeInView(
      application,
      dmsUrl,
      `document.querySelector('[data-testid="navigate-detail"]').click(); true`,
    );
    await waitForView(application, dmsDetailsUrl);
    await expect
      .poll(async () => {
        const current = (await getWorkspace(page)).tabs.find(
          (item) => item.id === "dms-restored",
        );
        return current && {
          product: current.product,
          regionId: current.regionId,
          url: current.url,
        };
      })
      .toEqual({ product: "dms", regionId: null, url: dmsDetailsUrl });

    await executeInView(
      application,
      dmsDetailsUrl,
      `document.querySelector('[data-testid="open-console-popup"]').click(); true`,
    );
    await expect
      .poll(async () => {
        const snapshot = await getWorkspace(page);
        return snapshot.tabs.map((item) => ({
          product: item.product,
          regionId: item.regionId,
          url: item.url,
        }));
      })
      .toEqual([
        { product: "dms", regionId: null, url: dmsDetailsUrl },
        { product: "dms", regionId: null, url: "https://dms.aliyun.com/" },
      ]);

    await executeInView(
      application,
      dmsDetailsUrl,
      `document.querySelector('[data-testid="open-console-popup"]').click(); true`,
    );
    await expect
      .poll(async () => (await getWorkspace(page)).tabs.length)
      .toBe(2);
    await expect
      .poll(() =>
        application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      )
      .toBe(1);
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("restores a regionless Codeup view and deduplicates captured Codeup popups", async () => {
  const codeupUrl = `${fakeConsole.baseUrl}/codeup`;
  const codeupDetailsUrl = `${fakeConsole.baseUrl}/codeup/details`;
  const codeupTab = tab("codeup-restored", "codeup", null, codeupUrl, 1);
  const userData = await createUserData(configuredSnapshot([codeupTab], codeupTab.id));
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();
    await waitForView(application, codeupUrl);

    await expect(
      page.getByRole("tab", { name: "Codeup fake console", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Codeup", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator(".toolbar-context")).toHaveText("Codeup");

    expect(
      await executeInView<{ hasRegion: boolean; product: string; regionRow: boolean }>(
        application,
        codeupUrl,
        `(() => {
          const ready = document.querySelector('[data-testid="console-ready"]');
          return {
            hasRegion: ready.hasAttribute('data-region'),
            product: ready.dataset.product,
            regionRow: Boolean(document.querySelector('[data-testid="console-region"]')),
          };
        })()`,
      ),
    ).toEqual({ hasRegion: false, product: "codeup", regionRow: false });

    await executeInView(
      application,
      codeupUrl,
      `document.querySelector('[data-testid="navigate-detail"]').click(); true`,
    );
    await waitForView(application, codeupDetailsUrl);
    await expect
      .poll(async () => {
        const current = (await getWorkspace(page)).tabs.find(
          (item) => item.id === "codeup-restored",
        );
        return current && {
          product: current.product,
          regionId: current.regionId,
          url: current.url,
        };
      })
      .toEqual({ product: "codeup", regionId: null, url: codeupDetailsUrl });

    await page.getByRole("button", { name: "Codeup", exact: true }).click();
    await expect
      .poll(async () => {
        const snapshot = await getWorkspace(page);
        return {
          activeTabId: snapshot.activeTabId,
          tabs: snapshot.tabs.map((item) => ({
            product: item.product,
            regionId: item.regionId,
            url: item.url,
          })),
        };
      })
      .toEqual({
        activeTabId: codeupTab.id,
        tabs: [{ product: "codeup", regionId: null, url: codeupDetailsUrl }],
      });
    await waitForView(application, codeupDetailsUrl);

    await executeInView(
      application,
      codeupDetailsUrl,
      `document.querySelector('[data-testid="open-console-popup"]').click(); true`,
    );
    await expect
      .poll(async () => {
        const snapshot = await getWorkspace(page);
        return snapshot.tabs.map((item) => ({
          product: item.product,
          regionId: item.regionId,
          url: item.url,
        }));
      })
      .toEqual([
        { product: "codeup", regionId: null, url: codeupDetailsUrl },
        { product: "codeup", regionId: null, url: "https://codeup.aliyun.com/" },
      ]);

    await executeInView(
      application,
      codeupDetailsUrl,
      `document.querySelector('[data-testid="open-console-popup"]').click(); true`,
    );
    await expect
      .poll(async () => (await getWorkspace(page)).tabs.length)
      .toBe(2);
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("restores a regionless SLS view", async () => {
  const slsUrl = `${fakeConsole.baseUrl}/sls`;
  const slsDetailsUrl = `${fakeConsole.baseUrl}/sls/details`;
  const slsTab = tab("sls-restored", "sls", null, slsUrl, 1);
  const userData = await createUserData(configuredSnapshot([slsTab], slsTab.id));
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();
    await waitForView(application, slsUrl);

    await expect(page.getByRole("tab", { name: "SLS fake console", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "SLS", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("button", { name: "SLS · 示例应用日志" })).not.toBeVisible();
    await expect(page.locator(".toolbar-context")).toHaveText("SLS");

    expect(
      await executeInView<{ hasRegion: boolean; product: string }>(
        application,
        slsUrl,
        `(() => {
          const ready = document.querySelector('[data-testid="console-ready"]');
          return { hasRegion: ready.hasAttribute('data-region'), product: ready.dataset.product };
        })()`,
      ),
    ).toEqual({ hasRegion: false, product: "sls" });

    await executeInView(
      application,
      slsUrl,
      `document.querySelector('[data-testid="navigate-detail"]').click(); true`,
    );
    await waitForView(application, slsDetailsUrl);
    await expect
      .poll(async () => {
        const current = (await getWorkspace(page)).tabs.find(
          (item) => item.id === "sls-restored",
        );
        return current && {
          product: current.product,
          regionId: current.regionId,
          url: current.url,
        };
      })
      .toEqual({ product: "sls", regionId: null, url: slsDetailsUrl });

  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("recovers the activation queue after a failed load and synchronizes in-page navigation", async () => {
  const failedUrl = `${fakeConsole.baseUrl}/network-error`;
  const ackUrl = `${fakeConsole.baseUrl}/ack?region=cn-beijing`;
  const initialTabs = [
    tab("failed", "ack", "cn-beijing", failedUrl, 1),
    tab("healthy", "ack", "cn-beijing", ackUrl, 2),
  ];
  const userData = await createUserData(configuredSnapshot(initialTabs, "failed"));
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect
      .poll(async () => (await getWorkspace(page)).tabs.find((item) => item.id === "failed")?.loadState)
      .toBe("error");

    const activation = await dispatch(page, { type: "activate-tab", tabId: "healthy" });
    expect(activation.ok).toBe(true);
    await waitForView(application, ackUrl);
    await expect
      .poll(async () =>
        (await getViewTree(application!)).filter((view) => view.visible).map((view) => view.url),
      )
      .toEqual([ackUrl]);

    const kafkaUrl = `${fakeConsole.baseUrl}/kafka/details?region=cn-shanghai`;
    await executeInView(
      application,
      ackUrl,
      `location.href = ${JSON.stringify(kafkaUrl)}; true`,
    );
    await waitForView(application, kafkaUrl);
    await expect
      .poll(async () => {
        const current = (await getWorkspace(page)).tabs.find((item) => item.id === "healthy");
        return current && { product: current.product, regionId: current.regionId, url: current.url };
      })
      .toEqual({ product: "kafka", regionId: "cn-shanghai", url: kafkaUrl });
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("recovers the local shell after its renderer crashes", async () => {
  const userData = await createUserData(configuredSnapshot());
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();

    await application.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents;
      if (!contents) throw new Error("Missing shell WebContents");
      const recovered = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Shell recovery timed out")), 15_000);
        contents.once("did-finish-load", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      contents.forcefullyCrashRenderer();
      await recovered;
    });

    await expect.poll(() => application?.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window || window.webContents.isDestroyed()) return false;
      return window.webContents.executeJavaScript(
        `Boolean(document.querySelector('.app-shell')) && document.body.innerText.includes('应用界面已自动恢复')`,
      ).catch(() => false);
    }), { timeout: 15_000 }).toBe(true);
  } finally {
    await application?.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("switches away from a slow page before its load completes", async () => {
  const slowUrl = `${fakeConsole.baseUrl}/slow?delay=2000`;
  const healthyUrl = `${fakeConsole.baseUrl}/kafka?region=cn-shanghai`;
  const initialTabs = [
    tab("slow", "ack", "cn-beijing", slowUrl, 1),
    tab("healthy", "kafka", "cn-shanghai", healthyUrl, 2),
  ];
  const userData = await createUserData(configuredSnapshot(initialTabs, "slow"));
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();

    const switchStartedAt = Date.now();
    expect((await dispatch(page, { type: "activate-tab", tabId: "healthy" })).ok).toBe(true);
    await waitForView(application, healthyUrl);
    await expect
      .poll(async () =>
        (await getViewTree(application!)).filter((view) => view.visible).map((view) => view.url),
      )
      .toEqual([healthyUrl]);
    expect(Date.now() - switchStartedAt).toBeLessThan(1_000);

    await expect
      .poll(async () => (await getWorkspace(page)).tabs.find((item) => item.id === "slow")?.loadState)
      .toBe("ready");
    const viewsAfterSlowLoad = await getViewTree(application);
    expect(viewsAfterSlowLoad.filter((view) => view.visible).map((view) => view.url)).toEqual([
      healthyUrl,
    ]);
    expect(viewsAfterSlowLoad.at(-1)?.url).toBe(healthyUrl);
    expect((await getWorkspace(page)).activeTabId).toBe("healthy");
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("cancels application quit for unsaved pages and restores pages closed earlier in the attempt", async () => {
  const ordinaryUrl = `${fakeConsole.baseUrl}/ack/ordinary?region=cn-beijing`;
  const guardedUrl = `${fakeConsole.baseUrl}/ack/guarded?region=cn-beijing`;
  const ordinary = tab("ordinary", "ack", "cn-beijing", ordinaryUrl, 1);
  const guarded = tab("guarded", "ack", "cn-beijing", guardedUrl, 2);
  const userData = await createUserData(configuredSnapshot([ordinary, guarded], ordinary.id));
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await waitForView(application, ordinaryUrl);
    await dispatch(page, { type: "activate-tab", tabId: guarded.id });
    await waitForView(application, guardedUrl);
    application.context().pages().find((candidate) => candidate.url() === guardedUrl)?.on("dialog", () => {});
    await executeInView(application, guardedUrl, `window.unsavedDraft = 'keep me'; window.quitGuard = (event) => { event.preventDefault(); event.returnValue = 'unsaved'; }; window.addEventListener('beforeunload', window.quitGuard); true`);
    await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
    await expect(page.getByRole("status")).toContainText("页面阻止退出");
    expect(await executeInView(application, guardedUrl, "window.unsavedDraft")).toBe("keep me");
    expect((await getWorkspace(page)).tabs).toHaveLength(2);
    await dispatch(page, { type: "activate-tab", tabId: ordinary.id });
    await waitForView(application, ordinaryUrl);
    await dispatch(page, { type: "activate-tab", tabId: guarded.id });
    expect(await executeInView(application, guardedUrl, "window.unsavedDraft")).toBe("keep me");
    await executeInView(application, guardedUrl, "window.removeEventListener('beforeunload', window.quitGuard); true");
    await closeApp(application);
    application = null;
  } finally {
    if (application) await executeInView(application, guardedUrl, "window.removeEventListener('beforeunload', window.quitGuard); true").catch(() => undefined);
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("restores the active view after logout fails and permits retrying cleanup", async () => {
  const url = `${fakeConsole.baseUrl}/ack/logout?region=cn-beijing`;
  const active = tab("logout", "ack", "cn-beijing", url, 1);
  const userData = await createUserData(configuredSnapshot([active], active.id));
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await waitForView(application, url);
    await application.evaluate(({ session }) => {
      const consoleSession = session.fromPartition("persist:aliyun");
      const clear = consoleSession.clearData.bind(consoleSession);
      consoleSession.clearData = async () => {
        consoleSession.clearData = clear;
        throw new Error("injected cleanup failure");
      };
    });
    await selectNativeMenu(application, page, "退出 RAM 登录…");
    const dialog = page.getByRole("dialog", { name: "退出 RAM 登录" });
    await dialog.getByRole("button", { name: "退出并清除会话" }).click();
    await expect(dialog.getByRole("alert")).toContainText("退出登录未完成");
    await waitForView(application, url);
    await dialog.getByRole("button", { name: "取消" }).click();
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect.poll(async () => (await getWorkspace(page)).tabs[0].loadState).toBe("ready");
    expect((await getViewTree(application)).filter((view) => view.visible)).toHaveLength(1);
    await selectNativeMenu(application, page, "退出 RAM 登录…");
    await page.getByRole("button", { name: "退出并清除会话" }).click();
    await expect.poll(async () => (await getWorkspace(page)).tabs.length).toBe(0);
    expect(await getViewTree(application)).toEqual([]);
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("preserves POST bodies and referrers in distinct console popup tabs", async () => {
  const url = `${fakeConsole.baseUrl}/ack/form?region=cn-beijing`;
  const active = tab("form", "ack", "cn-beijing", url, 1);
  const userData = await createUserData(configuredSnapshot([active], active.id));
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await waitForView(application, url);
    for (const marker of ["first", "second"]) {
      await dispatch(page, { type: "activate-tab", tabId: active.id });
      await executeInView(application, url, `(() => { const form = document.createElement('form'); form.target = '_blank'; form.method = 'POST'; form.action = '/ack/post-receipt?region=cn-beijing'; const input = document.createElement('input'); input.name = 'payload'; input.value = '${marker}'; form.append(input); document.body.append(form); form.submit(); return true; })()`);
      await expect.poll(async () => (await getWorkspace(page)).tabs.length).toBe(marker === "first" ? 2 : 3);
      await waitForView(application, `${fakeConsole.baseUrl}/ack/post-receipt`);
      await expect.poll(async () => application!.evaluate(async ({ BrowserWindow, WebContentsView }) => {
        const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child instanceof WebContentsView && child.getVisible()) as Electron.WebContentsView | undefined;
        return view?.webContents.executeJavaScript("document.querySelector('#receipt')?.textContent ?? ''");
      })).toContain(`payload=${marker}`);
    }
    const receipt = await application.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child instanceof WebContentsView && child.getVisible()) as Electron.WebContentsView;
      return view.webContents.executeJavaScript("JSON.parse(document.querySelector('#receipt').textContent)");
    });
    expect(receipt).toMatchObject({ method: "POST", body: "payload=second", referrer: url });
    expect(receipt.contentType).toContain("application/x-www-form-urlencoded");
    const saved = await fs.readFile(join(userData, "workspace.json"), "utf8");
    expect(saved).not.toContain("payload=");
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("keeps favorite row hit areas stable and exposes item actions through native menus", async ({}, testInfo) => {
  const snapshot = configuredSnapshot();
  snapshot.favorites = [{ id: "favorite", name: "生产集群收藏", product: "ack", regionId: "cn-beijing", url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing", createdAt: 1 }];
  const userData = await createUserData(snapshot);
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 680));
    const favorite = page.getByRole("button", { name: "生产集群收藏", exact: true });
    await favorite.scrollIntoViewIfNeeded();
    const padding = await favorite.evaluate((button) => getComputedStyle(button).paddingRight);
    await favorite.hover();
    expect(await favorite.evaluate((button) => getComputedStyle(button).paddingRight)).toBe(padding);
    expect(await favorite.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("compact-actions-1024.png") });
    const items = await selectNativeMenu(application, page, null, "更多操作 生产集群收藏");
    expect(items).toContainEqual({ label: "上移", enabled: false });
    expect(items).toContainEqual({ label: "下移", enabled: false });
    await selectNativeMenu(application, page, "重命名…", "更多操作 生产集群收藏");
    const dialog = page.getByRole("dialog", { name: "重命名收藏" });
    const input = dialog.getByRole("textbox");
    await input.fill("中文候选");
    await input.dispatchEvent("keydown", { key: "Enter", isComposing: true, keyCode: 229, bubbles: true });
    await expect(dialog).toBeVisible();
    expect((await getWorkspace(page)).favorites[0].name).toBe("生产集群收藏");
    await input.press("Enter");
    await expect(dialog).toHaveCount(0);
    expect((await getWorkspace(page)).favorites[0].name).toBe("中文候选");
    await selectNativeMenu(application, page, "删除", "更多操作 中文候选");
    await page.getByRole("button", { name: "撤销删除 中文候选" }).click();
    await expect(favorite).toHaveCount(0);
    expect((await getWorkspace(page)).favorites[0].name).toBe("中文候选");
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("honors beforeunload for a normal close and bypasses it only during logout", async () => {
  const guardedUrl = `${fakeConsole.baseUrl}/ack/details?region=cn-beijing`;
  const guardedTab = tab("guarded", "ack", "cn-beijing", guardedUrl, 1);
  const userData = await createUserData(configuredSnapshot([guardedTab], guardedTab.id));
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();
    await waitForView(application, guardedUrl);

    const unguardedUrl = `${fakeConsole.baseUrl}/kafka/details?region=cn-shanghai`;
    expect((await dispatch(page, {
      type: "open-url",
      product: "kafka",
      regionId: "cn-shanghai",
      url: unguardedUrl,
    })).ok).toBe(true);
    await waitForView(application, unguardedUrl);
    const unguarded = (await getWorkspace(page)).tabs.find((item) => item.url === unguardedUrl);
    if (!unguarded) throw new Error("Unguarded tab not found");
    expect((await dispatch(page, { type: "close-tab", tabId: unguarded.id })).ok).toBe(true);
    await expect
      .poll(async () => (await getViewTree(application!)).map((view) => view.url))
      .toEqual([guardedUrl]);

    const guardedPage = application.context().pages().find((candidate) =>
      candidate.url().startsWith(guardedUrl),
    );
    guardedPage?.on("dialog", () => {
      // Keep Playwright from auto-dismissing the beforeunload prompt that Electron handles.
    });
    await executeInView(
      application,
      guardedUrl,
      `window.addEventListener("beforeunload", (event) => {
        event.preventDefault();
        event.returnValue = "unsaved";
      }); true`,
    );

    const closeResult = await dispatch(page, { type: "close-tab", tabId: guardedTab.id });
    expect(closeResult).toEqual({ ok: true });
    const afterClose = await getWorkspace(page);
    expect(afterClose.tabs.map((item) => item.id)).toEqual([guardedTab.id]);
    expect(afterClose.notice).toContain("页面阻止关闭");
    expect((await getViewTree(application)).map((view) => view.url)).toEqual([guardedUrl]);

    expect((await dispatch(page, {
      type: "open-url",
      product: "kafka",
      regionId: "cn-shanghai",
      url: unguardedUrl,
    })).ok).toBe(true);
    await waitForView(application, unguardedUrl);
    const reopenedUnguarded = (await getWorkspace(page)).tabs.find((item) => item.url === unguardedUrl);
    if (!reopenedUnguarded) throw new Error("Reopened unguarded tab not found");
    expect((await dispatch(page, {
      type: "set-tab-task-status",
      tabId: guardedTab.id,
      taskStatus: "done",
    })).ok).toBe(true);
    expect((await dispatch(page, {
      type: "set-tab-task-status",
      tabId: reopenedUnguarded.id,
      taskStatus: "done",
    })).ok).toBe(true);

    const batchResult = await dispatch(page, { type: "close-tabs", scope: "completed" });
    expect(batchResult).toEqual({ ok: true });
    const afterBatchClose = await getWorkspace(page);
    expect(afterBatchClose.tabs.map((item) => item.id)).toEqual([guardedTab.id]);
    expect(afterBatchClose.notice).toBe("已关闭 1 个标签，1 个页面阻止关闭");
    await expect.poll(async () =>
      (await getViewTree(application!)).filter((view) => view.visible).map((view) => view.url),
    ).toEqual([guardedUrl]);

    const logoutResult = await page.evaluate(() =>
      (
        window as typeof window & {
          opsdock: { logout(): Promise<WorkspaceResult> };
        }
      ).opsdock.logout(),
    );
    expect(logoutResult.ok).toBe(true);
    await expect.poll(async () => (await getViewTree(application!)).length).toBe(0);
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("denies permissions and untrusted downloads without destabilizing the shell", async () => {
  const permissionsUrl = `${fakeConsole.baseUrl}/permissions`;
  const userData = await createUserData(configuredSnapshot());
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();

    const opened = await dispatch(page, {
      type: "open-url",
      product: "ack",
      regionId: "cn-beijing",
      url: permissionsUrl,
      title: "Permission probe",
    });
    expect(opened.ok).toBe(true);
    await waitForView(application, permissionsUrl);

    const permissions = await executeInView<{
      camera: string;
      notifications: NotificationPermission;
    }>(
      application,
      permissionsUrl,
      `void 0; (async () => ({
        camera: await navigator.mediaDevices.getUserMedia({ video: true })
          .then(() => "granted", (error) => error.name),
        notifications: await Notification.requestPermission(),
      }))()`,
    );
    expect(permissions.camera).not.toBe("granted");
    expect(permissions.notifications).toBe("denied");

    const downloadsDirectory = join(userData, "Downloads");
    await fs.mkdir(downloadsDirectory);
    await application.evaluate(({ app }, path) => {
      app.setPath("downloads", path);
    }, downloadsDirectory);
    const expectedDownload = join(downloadsDirectory, "opsdock-test-download.txt");
    await executeInView(
      application,
      permissionsUrl,
      `(() => {
        const link = document.createElement("a");
        link.href = ${JSON.stringify(`${fakeConsole.baseUrl}/download`)};
        link.download = "opsdock-test-download.txt";
        document.body.append(link);
        link.click();
        link.remove();
        return true;
      })()`,
    );
    await expect(page.getByRole("status")).toContainText(
      "仅允许从阿里云控制台页面下载文件",
    );
    await expect
      .poll(async () =>
        fs.access(expectedDownload).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
    await page.getByRole("button", { name: "关闭提示" }).click();
    await expect(page.getByRole("status")).not.toBeVisible();

    await application.evaluate(({ webContents }, prefix) => {
      const target = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(prefix));
      if (!target) throw new Error("Crash target not found");
      target.forcefullyCrashRenderer();
    }, permissionsUrl);

    await expect(page.getByRole("heading", { name: "控制台页面已停止" })).toBeVisible();
    await expect(page.getByRole("button", { name: "重新加载" })).toBeVisible();
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.isDestroyed(),
      ),
    ).toBe(false);

    await page.getByRole("button", { name: "重新加载" }).click();
    await expect
      .poll(async () => (await getWorkspace(page)).tabs.find((item) => item.url === permissionsUrl)?.loadState)
      .toBe("ready");
    await expect
      .poll(async () =>
        (await getViewTree(application!)).filter((view) => view.visible).map((view) => view.url),
      )
      .toEqual([permissionsUrl]);
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("allows trusted console downloads through the native save flow", async () => {
  const dmsUrl = `${fakeConsole.baseUrl}/dms/export`;
  const userData = await createUserData(configuredSnapshot());
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();

    const opened = await dispatch(page, {
      type: "open-url",
      product: "dms",
      regionId: null,
      url: dmsUrl,
      title: "DMS export",
    });
    expect(opened.ok).toBe(true);
    await waitForView(application, dmsUrl);

    const downloadsDirectory = join(userData, "Downloads");
    await fs.mkdir(downloadsDirectory);
    const expectedDownload = join(downloadsDirectory, "opsdock-test-download.txt");
    await application.evaluate(({ session }, savePath) => {
      const state = globalThis as typeof globalThis & {
        __opsdockDownloadDialog?: Electron.SaveDialogOptions;
      };
      state.__opsdockDownloadDialog = undefined;
      session.fromPartition("persist:aliyun").once("will-download", (_event, item) => {
        state.__opsdockDownloadDialog = item.getSaveDialogOptions();
        item.setSavePath(savePath);
      });
    }, expectedDownload);

    await executeInView(
      application,
      dmsUrl,
      `document.querySelector('[data-testid="download-attachment"]').click(); true`,
    );
    await expect.poll(() =>
      fs.readFile(expectedDownload, "utf8").catch(() => null),
    ).toBe(
      "CloudDock fake console attachment\n",
    );
    expect(
      await application.evaluate(() => (
        globalThis as typeof globalThis & {
          __opsdockDownloadDialog?: Electron.SaveDialogOptions;
        }
      ).__opsdockDownloadDialog),
    ).toMatchObject({
      title: "保存控制台文件",
      buttonLabel: "保存",
    });
    await expect(page.getByText("下载完成：opsdock-test-download.txt")).toBeVisible();
    await expect(page.getByText("仅允许从阿里云控制台页面下载文件")).toHaveCount(0);
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("bounds live views during batch retry and leaves hidden views unchanged on resize", async () => {
  const tabs = Array.from({ length: 20 }, (_, index) =>
    tab(`retry-${index}`, "codeup", null, `${fakeConsole.baseUrl}/codeup/details?tab=${index}`, index));
  const userData = await createUserData(configuredSnapshot(tabs, tabs[0].id));
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    const page = await application.firstWindow();
    await waitForView(application, tabs[0].url);
    await expect.poll(async () => (await getWorkspace(page)).tabs[0].loadState).toBe("ready");
    for (const tab of tabs.slice(1)) {
      expect(await dispatch(page, { type: "update-tab", tabId: tab.id, loadState: "error" })).toEqual({ ok: true });
    }
    const result = await page.evaluate(() => (window as typeof window & { opsdock: OpsDockApi }).opsdock.retryFailedTabs());
    expect(result).toEqual({ attempted: 19, succeeded: 19, failed: 0 });
    await expect.poll(async () => (await getViewTree(application!)).length).toBeLessThanOrEqual(8);
    const previousClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
    try {
      await page.evaluate(() => (window as typeof window & { opsdock: OpsDockApi }).opsdock.copyDiagnostics());
      const summary = await application.evaluate(({ clipboard }) => clipboard.readText());
      expect(Number(/Peak live views: (\d+)/.exec(summary)?.[1])).toBeLessThanOrEqual(9);
      expect(Number(/Recycled views: (\d+)/.exec(summary)?.[1])).toBeGreaterThanOrEqual(12);
      expect(summary).not.toContain(fakeConsole.baseUrl);
    } finally {
      await application.evaluate(({ clipboard }, previous) => clipboard.writeText(previous), previousClipboard);
    }
    const before = await getViewTree(application);
    const active = before.find((view) => view.visible)!;
    const background = before.find((view) => !view.visible)!;
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1400, 900));
    await expect.poll(async () => (await getViewTree(application!)).find((view) => view.visible)!.bounds.width).toBeGreaterThan(active.bounds.width);
    const resized = await getViewTree(application);
    expect(resized.find((view) => view.id === background.id)!.bounds).toEqual(background.bounds);
    const newBounds = resized.find((view) => view.visible)!.bounds;
    const hiddenTab = (await getWorkspace(page)).tabs.find((tab) => tab.url === background.url)!;
    await dispatch(page, { type: "activate-tab", tabId: hiddenTab.id });
    await expect.poll(async () => (await getViewTree(application!)).find((view) => view.visible)?.bounds).toEqual(newBounds);
  } finally {
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("keeps at most eight live remote views and reloads a recycled tab", async () => {
  const tabs = Array.from({ length: 10 }, (_, index) => {
    const product = index % 2 === 0 ? "ack" as const : "kafka" as const;
    const regionId = index % 2 === 0 ? "cn-beijing" : "cn-shanghai";
    const url = `${fakeConsole.baseUrl}/${product}/details?region=${regionId}&tab=${index + 1}`;
    return tab(`tab-${index + 1}`, product, regionId, url, index + 1);
  });
  const userData = await createUserData(configuredSnapshot(tabs, tabs[0].id));
  let application: ElectronApplication | null = null;
  try {
    application = await launchApp(userData);
    // Electron handles beforeunload; subscribe before Playwright discovers the remote page.
    application.context().on("dialog", () => {});
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();

    await waitForView(application, tabs[0].url);
    await executeInView(
      application,
      tabs[0].url,
      `window.recycleGuard = (event) => {
        event.preventDefault();
        event.returnValue = "unsaved";
      }; window.addEventListener("beforeunload", window.recycleGuard); true`,
    );

    for (const current of tabs) {
      if (current.id !== tabs[0].id) {
        expect((await dispatch(page, { type: "activate-tab", tabId: current.id })).ok).toBe(true);
      }
      await waitForView(application, current.url);
      await expect
        .poll(async () =>
          (await getViewTree(application!)).filter((view) => view.visible).map((view) => view.url),
        )
        .toEqual([current.url]);
    }

    const liveViews = await getViewTree(application);
    expect(liveViews.length).toBeLessThanOrEqual(8);
    expect(liveViews.filter((view) => view.visible).map((view) => view.url)).toEqual([
      tabs.at(-1)!.url,
    ]);
    expect(liveViews.map((view) => view.url)).toContain(tabs[0].url);
    const snapshot = await getWorkspace(page);
    const recycled = snapshot.tabs.filter((current) => current.loadState === "deferred");
    expect(recycled.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.activeTabId).toBe("tab-10");
    expect(snapshot.tabs.find((current) => current.id === tabs[0].id)?.loadState).not.toBe("deferred");
    expect(snapshot.notice ?? "").not.toContain("后台页面回收失败");

    expect((await dispatch(page, { type: "activate-tab", tabId: recycled[0].id })).ok).toBe(true);
    await waitForView(application, recycled[0].url);
    await expect
      .poll(async () =>
        (await getViewTree(application!)).filter((view) => view.visible).map((view) => view.url),
      )
      .toEqual([recycled[0].url]);
  } finally {
    if (application) await executeInView(application, tabs[0].url, "window.removeEventListener('beforeunload', window.recycleGuard); true").catch(() => undefined);
    await closeApp(application);
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test("persists the isolated console session and clears it on logout", async () => {
  const setupUrl = `${fakeConsole.baseUrl}/storage/setup`;
  const inspectUrl = `${fakeConsole.baseUrl}/storage/inspect`;
  const snapshot = configuredSnapshot();
  snapshot.favorites.push({
    id: "favorite-ack",
    name: "Saved ACK page",
    product: "ack",
    regionId: "cn-beijing",
    url: `${fakeConsole.baseUrl}/ack/details?region=cn-beijing`,
    createdAt: 1,
  });
  const userData = await createUserData(snapshot);
  let firstApplication: ElectronApplication | null = null;
  let secondApplication: ElectronApplication | null = null;
  try {
    firstApplication = await launchApp(userData);
    const firstPage = await firstApplication.firstWindow();
    await expect(firstPage.locator(".app-shell")).toBeVisible();
    expect(
      (
        await dispatch(firstPage, {
          type: "open-url",
          product: "ack",
          regionId: "cn-beijing",
          url: setupUrl,
          title: "Storage setup",
        })
      ).ok,
    ).toBe(true);
    await waitForView(firstApplication, setupUrl);
    await expect.poll(() => executeInView<string>(firstApplication!, setupUrl,
      'document.querySelector("[data-testid=storage-status]")?.textContent ?? ""')).toBe("ready");

    await executeInView(
      firstApplication,
      setupUrl,
      `void 0; (async () => {
        document.cookie = "opsdock-e2e=present; Max-Age=3600; SameSite=Lax; Path=/";
        localStorage.setItem("opsdock-e2e", "present");
        await new Promise((resolve, reject) => {
          const request = indexedDB.open("opsdock-e2e", 1);
          request.onupgradeneeded = () => request.result.createObjectStore("values");
          request.onsuccess = () => { request.result.close(); resolve(undefined); };
          request.onerror = () => reject(request.error);
        });
        const cache = await caches.open("opsdock-e2e");
        await cache.put("/cached", new Response("cached"));
        await navigator.serviceWorker.register("/service-worker.js");
        await navigator.serviceWorker.ready;
        return true;
      })()`,
    );

    expect(
      (
        await dispatch(firstPage, {
          type: "open-url",
          product: "ack",
          regionId: "cn-beijing",
          url: inspectUrl,
          title: "Storage inspect",
        })
      ).ok,
    ).toBe(true);
    await waitForView(firstApplication, inspectUrl);
    await expect.poll(() => executeInView<string>(firstApplication!, inspectUrl,
      'document.querySelector("[data-testid=storage-inspection-status]")?.textContent ?? ""')).toBe("ready");
    await closeApp(firstApplication);
    firstApplication = null;

    secondApplication = await launchApp(userData);
    const secondPage = await secondApplication.firstWindow();
    await expect(secondPage.locator(".app-shell")).toBeVisible();
    await waitForView(secondApplication, inspectUrl);

    const persisted = await storageProbe(secondApplication, inspectUrl);
    expect(persisted.cookie).toContain("opsdock-e2e=present");
    expect(persisted.localStorageValue).toBe("present");
    expect(persisted.databaseNames).toContain("opsdock-e2e");
    expect(persisted.cacheKeys).toContain("opsdock-e2e");
    expect(persisted.serviceWorkerCount).toBeGreaterThan(0);

    const logoutSnapshot = await secondPage.evaluate(() =>
      (
        window as typeof window & {
          opsdock: { logout(): Promise<WorkspaceResult> };
        }
      ).opsdock.logout(),
    );
    expect(logoutSnapshot).toEqual({ ok: true });
    const afterLogout = await getWorkspace(secondPage);
    expect(afterLogout.tabs).toEqual([]);
    expect(afterLogout.activeTabId).toBeNull();
    expect(afterLogout.favorites).toHaveLength(1);
    expect(afterLogout.productRegionIds).toEqual({
      ack: TEST_REGION_IDS,
      kafka: TEST_REGION_IDS,
      mse: TEST_REGION_IDS,
    });
    await expect.poll(async () => (await getViewTree(secondApplication!)).length).toBe(0);

    const cookiesAfterLogout = await secondApplication.evaluate(
      async ({ session }, url) =>
        session.fromPartition("persist:aliyun").cookies.get({ url }),
      fakeConsole.baseUrl,
    );
    expect(cookiesAfterLogout).toEqual([]);

    expect(
      (
        await dispatch(secondPage, {
          type: "open-url",
          product: "ack",
          regionId: "cn-beijing",
          url: inspectUrl,
          title: "Storage inspect after logout",
        })
      ).ok,
    ).toBe(true);
    await waitForView(secondApplication, inspectUrl);
    const cleared = await storageProbe(secondApplication, inspectUrl);
    expect(cleared.cookie).not.toContain("opsdock-e2e=");
    expect(cleared.localStorageValue).toBeNull();
    expect(cleared.databaseNames).not.toContain("opsdock-e2e");
    expect(cleared.cacheKeys).not.toContain("opsdock-e2e");
    expect(cleared.serviceWorkerCount).toBe(0);
  } finally {
    await closeApp(firstApplication);
    await closeApp(secondApplication);
    await fs.rm(userData, { recursive: true, force: true });
  }
});
