import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileSnapshotStore,
  type PersistenceFileSystem,
} from "../../src/main/modules/workspace/persistence";
import {
  createDefaultSnapshot,
  type WorkspaceSnapshot,
} from "../../src/shared/model";

const temporaryDirectories: string[] = [];

async function temporaryWorkspacePath(): Promise<{
  directory: string;
  filePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "opsdock-persistence-"));
  temporaryDirectories.push(directory);
  return { directory, filePath: join(directory, "workspace.json") };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("FileSnapshotStore.load", () => {
  it("returns a fresh default snapshot when the file is missing", async () => {
    const { filePath } = await temporaryWorkspacePath();
    const persistence = new FileSnapshotStore({ filePath });

    const first = await persistence.load();
    first.productRegionIds.ack.push("changed-by-test");
    const second = await persistence.load();

    expect(second).toEqual(createDefaultSnapshot());
  });

  it.each(["not-json", JSON.stringify({ schemaVersion: 1, tabs: "bad" })])(
    "backs up corrupt persisted data before falling back",
    async (contents) => {
      const { directory, filePath } = await temporaryWorkspacePath();
      await writeFile(filePath, contents);
      const persistence = new FileSnapshotStore({ filePath });

      await expect(persistence.load()).resolves.toEqual({
        ...createDefaultSnapshot(),
        notice: "工作区数据损坏或版本不兼容，已备份原文件并恢复默认设置",
      });
      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^workspace\.json\.[0-9a-f-]+\.backup$/);
      expect(await readFile(join(directory, files[0]), "utf8")).toBe(contents);
    },
  );

  it("backs up a snapshot with an unknown schema version", async () => {
    const { directory, filePath } = await temporaryWorkspacePath();
    const contents = JSON.stringify({ schemaVersion: 99 });
    await writeFile(filePath, contents);

    const result = await new FileSnapshotStore({ filePath }).load();

    expect(result.notice).toContain("已备份原文件");
    const [backupPath] = await readdir(directory);
    expect(await readFile(join(directory, backupPath), "utf8")).toBe(contents);
  });

  it("loads a valid current snapshot", async () => {
    const { filePath } = await temporaryWorkspacePath();
    const snapshot: WorkspaceSnapshot = {
      ...createDefaultSnapshot(),
      onboardingComplete: true,
      sidebarCollapsed: true,
    };
    await writeFile(filePath, JSON.stringify(snapshot));

    await expect(
      new FileSnapshotStore({ filePath }).load(),
    ).resolves.toEqual(snapshot);
  });

  it("runs the migration hook before validating an older snapshot", async () => {
    const { filePath } = await temporaryWorkspacePath();
    const oldSnapshot = { schemaVersion: 0, regions: ["cn-shanghai"] };
    await writeFile(filePath, JSON.stringify(oldSnapshot));
    const migrate = vi.fn(() => ({
      ...createDefaultSnapshot(),
      productRegionIds: {
        ...createDefaultSnapshot().productRegionIds,
        ack: ["cn-shanghai"],
      },
      onboardingComplete: true,
    }));

    const result = await new FileSnapshotStore({
      filePath,
      migrate,
    }).load();

    expect(migrate).toHaveBeenCalledWith(oldSnapshot, 6);
    expect(result.productRegionIds.ack).toEqual(["cn-shanghai"]);
    expect(result.onboardingComplete).toBe(true);
  });

  it("migrates a v1 snapshot to v6 with every product and per-product regions", async () => {
    const { filePath } = await temporaryWorkspacePath();
    const { selectedProducts: _selectedProducts, productRegionIds: _productRegionIds, ...currentSnapshot } =
      createDefaultSnapshot();
    const oldSnapshot = {
      ...currentSnapshot,
      schemaVersion: 1,
      selectedRegionIds: ["cn-shenzhen"],
      onboardingComplete: true,
    };
    await writeFile(filePath, JSON.stringify(oldSnapshot));

    const result = await new FileSnapshotStore({ filePath }).load();

    expect(result).toMatchObject({
      schemaVersion: 6,
      onboardingComplete: true,
      selectedProducts: ["ack", "kafka", "mse", "dms", "codeup", "sls"],
      productRegionIds: {
        ack: ["cn-shenzhen"],
        kafka: ["cn-shenzhen"],
        mse: ["cn-beijing"],
      },
      recentVisits: [],
    });
  });

  it("keeps an existing MSE-compatible region unchanged during v1 migration", async () => {
    const { filePath } = await temporaryWorkspacePath();
    const { selectedProducts: _selectedProducts, productRegionIds: _productRegionIds, ...currentSnapshot } =
      createDefaultSnapshot();
    const oldSnapshot = {
      ...currentSnapshot,
      schemaVersion: 1,
      selectedRegionIds: ["cn-shanghai", "cn-shenzhen"],
    };
    await writeFile(filePath, JSON.stringify(oldSnapshot));

    const result = await new FileSnapshotStore({ filePath }).load();

    expect(result.productRegionIds).toEqual({
      ack: ["cn-shanghai", "cn-shenzhen"],
      kafka: ["cn-shanghai", "cn-shenzhen"],
      mse: ["cn-shanghai"],
    });
    expect(result.selectedProducts).toEqual([
      "ack",
      "kafka",
      "mse",
      "dms",
      "codeup",
      "sls",
    ]);
  });

  it("migrates a v2 snapshot while preserving selected modules", async () => {
    const { filePath } = await temporaryWorkspacePath();
    const { productRegionIds: _productRegionIds, ...currentSnapshot } =
      createDefaultSnapshot();
    const oldSnapshot = {
      ...currentSnapshot,
      schemaVersion: 2,
      selectedRegionIds: ["cn-shanghai", "cn-hangzhou"],
      selectedProducts: ["ack", "sls"],
      onboardingComplete: true,
    };
    await writeFile(filePath, JSON.stringify(oldSnapshot));

    const result = await new FileSnapshotStore({ filePath }).load();

    expect(result).toMatchObject({
      schemaVersion: 6,
      selectedProducts: ["ack", "sls"],
      productRegionIds: {
        ack: ["cn-shanghai", "cn-hangzhou"],
        kafka: ["cn-shanghai", "cn-hangzhou"],
        mse: ["cn-shanghai"],
      },
    });
  });

  it("migrates a v3 snapshot without changing module or region settings", async () => {
    const { filePath } = await temporaryWorkspacePath();
    const { moduleShortcuts: _moduleShortcuts, ...currentSnapshot } = createDefaultSnapshot();
    const oldSnapshot = {
      ...currentSnapshot,
      schemaVersion: 3,
      selectedProducts: ["codeup", "sls"],
      productRegionIds: { ack: ["cn-shenzhen"], kafka: ["cn-hangzhou"], mse: ["cn-shanghai"] },
    };
    await writeFile(filePath, JSON.stringify(oldSnapshot));

    const result = await new FileSnapshotStore({ filePath }).load();

    expect(result).toMatchObject({
      schemaVersion: 6,
      selectedProducts: ["codeup", "sls"],
      productRegionIds: { ack: ["cn-shenzhen"], kafka: ["cn-hangzhou"], mse: ["cn-shanghai"] },
      moduleShortcuts: [],
      recentVisits: [],
    });
  });

  it("migrates v4 tabs and recently closed tabs with default metadata", async () => {
    const { filePath } = await temporaryWorkspacePath();
    const { recentVisits: _recentVisits, ...currentSnapshot } = createDefaultSnapshot();
    const legacyTab = {
      id: "legacy-tab",
      product: "ack",
      regionId: "cn-beijing",
      url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
      title: "Legacy ACK",
      createdAt: 100,
      lastActiveAt: 200,
      loadState: "deferred",
      canGoBack: false,
      canGoForward: false,
    };
    const oldSnapshot = {
      ...currentSnapshot,
      schemaVersion: 4,
      tabs: [legacyTab],
      activeTabId: legacyTab.id,
      recentlyClosedTabs: [{ ...legacyTab, id: "legacy-closed" }],
    };
    await writeFile(filePath, JSON.stringify(oldSnapshot));

    const result = await new FileSnapshotStore({ filePath }).load();

    expect(result.schemaVersion).toBe(6);
    expect(result.tabs[0]).toMatchObject({ pinned: false, taskStatus: null });
    expect(result.recentlyClosedTabs[0]).toMatchObject({ pinned: false, taskStatus: null });
    expect(result.recentVisits).toEqual([]);
  });

  it("migrates v5 filters without changing existing workspace data", async () => {
    const { filePath } = await temporaryWorkspacePath();
    const {
      productFilter: _productFilter,
      taskFilter: _taskFilter,
      ...v5Snapshot
    } = createDefaultSnapshot();
    const tab = {
      id: "v5-tab",
      product: "ack" as const,
      regionId: "cn-beijing",
      url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
      title: "Pinned task",
      createdAt: 1,
      lastActiveAt: 2,
      pinned: true,
      taskStatus: "doing" as const,
      loadState: "deferred" as const,
      canGoBack: false,
      canGoForward: false,
    };
    const oldSnapshot = {
      ...v5Snapshot,
      schemaVersion: 5,
      tabs: [tab],
      activeTabId: tab.id,
      recentVisits: [{
        product: "ack" as const,
        regionId: "cn-beijing",
        url: tab.url,
        title: tab.title,
        visitedAt: 2,
      }],
      selectedProducts: ["ack" as const],
      productRegionIds: { ack: ["cn-beijing"], kafka: [], mse: [] },
    };
    await writeFile(filePath, JSON.stringify(oldSnapshot));

    const result = await new FileSnapshotStore({ filePath }).load();

    expect(result).toEqual({
      ...oldSnapshot,
      schemaVersion: 6,
      productFilter: "all",
      taskFilter: "all",
    });
  });

  it("migrates the v5 console home away from the old DMS placeholder product", async () => {
    const { filePath } = await temporaryWorkspacePath();
    const {
      productFilter: _productFilter,
      taskFilter: _taskFilter,
      ...v5Snapshot
    } = createDefaultSnapshot();
    const homeTab = {
      id: "console-home",
      product: "dms" as const,
      regionId: null,
      url: "https://home.console.aliyun.com/home/dashboard/ProductAndService",
      title: "控制台首页",
      createdAt: 1,
      lastActiveAt: 1,
      pinned: false,
      taskStatus: null,
      loadState: "deferred" as const,
      canGoBack: false,
      canGoForward: false,
    };
    await writeFile(filePath, JSON.stringify({
      ...v5Snapshot,
      schemaVersion: 5,
      tabs: [homeTab],
      activeTabId: homeTab.id,
      recentlyClosedTabs: [homeTab],
    }));

    const result = await new FileSnapshotStore({ filePath }).load();

    expect(result.tabs[0]).toMatchObject({ product: "aliyun", regionId: null });
    expect(result.recentlyClosedTabs[0]).toMatchObject({ product: "aliyun", regionId: null });
  });

  it("falls back when migration fails or returns an invalid snapshot", async () => {
    const { directory, filePath } = await temporaryWorkspacePath();
    const contents = JSON.stringify({ schemaVersion: 0 });
    await writeFile(filePath, contents);

    const result = await new FileSnapshotStore({
      filePath,
      migrate: () => ({ schemaVersion: 1 }),
    }).load();

    expect(result).toEqual({
      ...createDefaultSnapshot(),
      notice: "工作区数据损坏或版本不兼容，已备份原文件并恢复默认设置",
    });
    const [backupPath] = await readdir(directory);
    expect(await readFile(join(directory, backupPath), "utf8")).toBe(contents);
  });

  it("does not fall back when the original file cannot be backed up", async () => {
    const failure = new Error("rename failed");
    const fileSystem = {
      readFile: vi.fn().mockResolvedValue("not-json"),
      rename: vi.fn().mockRejectedValue(failure),
    } as unknown as PersistenceFileSystem;

    await expect(
      new FileSnapshotStore({ filePath: "/state.json", fileSystem }).load(),
    ).rejects.toBe(failure);
  });

  it("does not hide non-missing filesystem errors", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const fileSystem = {
      readFile: vi.fn().mockRejectedValue(denied),
    } as unknown as PersistenceFileSystem;

    await expect(
      new FileSnapshotStore({ filePath: "/state.json", fileSystem }).load(),
    ).rejects.toBe(denied);
  });
});

describe("FileSnapshotStore.save", () => {
  it("atomically replaces the snapshot and restricts it to mode 0600", async () => {
    const { directory, filePath } = await temporaryWorkspacePath();
    const persistence = new FileSnapshotStore({ filePath });
    const snapshot = { ...createDefaultSnapshot(), onboardingComplete: true };

    await persistence.save(snapshot);

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["workspace.json"]);
  });

  it("uses a same-directory temporary file before rename", async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const fileSystem: PersistenceFileSystem = {
      readFile: vi.fn(),
      mkdir: vi.fn(async (path) => {
        calls.push(["mkdir", path]);
      }),
      writeFile: vi.fn(async (path, _contents, mode) => {
        calls.push(["writeFile", path, mode]);
      }),
      chmod: vi.fn(async (path, mode) => {
        calls.push(["chmod", path, mode]);
      }),
      rename: vi.fn(async (from, to) => {
        calls.push(["rename", from, to]);
      }),
      unlink: vi.fn(),
    };

    await new FileSnapshotStore({
      filePath: "/state/workspace.json",
      fileSystem,
    }).save(createDefaultSnapshot());

    const temporaryPath = calls.find(([name]) => name === "writeFile")?.[1];
    expect(temporaryPath).toMatch(/^\/state\/workspace\.json\..+\.tmp$/);
    expect(calls).toEqual([
      ["mkdir", "/state"],
      ["writeFile", temporaryPath, 0o600],
      ["chmod", temporaryPath, 0o600],
      ["rename", temporaryPath, "/state/workspace.json"],
      ["chmod", "/state/workspace.json", 0o600],
    ]);
  });

  it("removes the temporary file when replacement fails", async () => {
    let temporaryPath = "";
    const failure = new Error("rename failed");
    const fileSystem: PersistenceFileSystem = {
      readFile: vi.fn(),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (path) => {
        temporaryPath = path;
      }),
      chmod: vi.fn(async () => undefined),
      rename: vi.fn(async () => {
        throw failure;
      }),
      unlink: vi.fn(async () => undefined),
    };
    const persistence = new FileSnapshotStore({
      filePath: "/state/workspace.json",
      fileSystem,
    });

    await expect(persistence.save(createDefaultSnapshot())).rejects.toBe(failure);
    expect(fileSystem.unlink).toHaveBeenCalledWith(temporaryPath);
  });

  it("serializes concurrent replacements in call order", async () => {
    const resolvers: Array<() => void> = [];
    const writes: string[] = [];
    const fileSystem: PersistenceFileSystem = {
      readFile: vi.fn(),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (_path, contents) => {
        writes.push(contents);
        await new Promise<void>((resolve) => resolvers.push(resolve));
      }),
      chmod: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };
    const persistence = new FileSnapshotStore({
      filePath: "/state/workspace.json",
      fileSystem,
    });

    const first = persistence.save({
      ...createDefaultSnapshot(),
      notice: "first",
    });
    const second = persistence.save({
      ...createDefaultSnapshot(),
      notice: "second",
    });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    resolvers.shift()?.();
    await first;
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    resolvers.shift()?.();
    await second;

    expect(writes.map((value) => JSON.parse(value).notice)).toEqual([
      "first",
      "second",
    ]);
  });
});
