import { randomUUID } from "node:crypto";
import { isMissingFile, nodeFileSystem, writePrivateFileAtomically, type PersistenceFileSystem } from "../../private-file";
export type { PersistenceFileSystem } from "../../private-file";
import {
  ConfigurableProductSchema,
  WorkspaceSnapshotSchema,
  WORKSPACE_SCHEMA_VERSION,
  createDefaultSnapshot,
  type ConfigurableProduct,
  type ProductRegionIds,
  type WorkspaceSnapshot,
} from "../../../shared/model";
import { MSE_REGION_IDS, PRODUCTS } from "../../../shared/products";
import { DEFAULT_REGION_IDS, isKnownRegion } from "../../../shared/regions";
import { CONSOLE_HOME_URL, normalizeConsoleUrl } from "../../../shared/console-url";

const CURRENT_SCHEMA_VERSION = WORKSPACE_SCHEMA_VERSION;
const RECOVERY_NOTICE = "工作区数据损坏或版本不兼容，已备份原文件并恢复默认设置";

export interface SnapshotStore {
  load(): Promise<WorkspaceSnapshot>;
  save(snapshot: WorkspaceSnapshot): Promise<void>;
}

export type WorkspaceMigration = (
  persistedValue: unknown,
  targetSchemaVersion: number,
) => unknown | Promise<unknown>;

export function migrateWorkspaceSnapshot(
  persistedValue: unknown,
  targetSchemaVersion: number,
): unknown {
  const schemaVersion = persistedSchemaVersion(persistedValue);
  if (
    targetSchemaVersion !== CURRENT_SCHEMA_VERSION
    || typeof persistedValue !== "object"
    || persistedValue === null
    || ![1, 2, 3, 4, 5].includes(schemaVersion as number)
  ) {
    throw new Error("不支持的工作区数据版本");
  }
  const rawTabs = Reflect.get(persistedValue, "tabs");
  const rawRecentlyClosedTabs = Reflect.get(persistedValue, "recentlyClosedTabs");
  const tabs = migrateConsoleHomeTabs(schemaVersion === 5 ? rawTabs : migrateTabs(rawTabs));
  const recentlyClosedTabs = migrateConsoleHomeTabs(
    schemaVersion === 5 ? rawRecentlyClosedTabs : migrateTabs(rawRecentlyClosedTabs),
  );
  if (schemaVersion === 5) {
    return {
      ...persistedValue,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      tabs,
      recentlyClosedTabs,
      productFilter: "all",
      taskFilter: "all",
    };
  }
  if (schemaVersion === 4) {
    return {
      ...persistedValue,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      tabs,
      recentlyClosedTabs,
      recentVisits: [],
      productFilter: "all",
      taskFilter: "all",
    };
  }
  if (schemaVersion === 3) {
    return {
      ...persistedValue,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      tabs,
      recentlyClosedTabs,
      moduleShortcuts: [],
      recentVisits: [],
      productFilter: "all",
      taskFilter: "all",
    };
  }

  const persistedRegionIds = Reflect.get(persistedValue, "selectedRegionIds");
  const selectedRegionIds = normalizeRegionIds(persistedRegionIds);
  const regionalDefaults = selectedRegionIds.length > 0
    ? selectedRegionIds
    : [...DEFAULT_REGION_IDS];

  return {
    ...persistedValue,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    tabs,
    recentlyClosedTabs,
    selectedProducts: schemaVersion === 1
      ? [...PRODUCTS]
      : normalizeProducts(Reflect.get(persistedValue, "selectedProducts")),
    productRegionIds: createProductRegionIds(regionalDefaults),
    moduleShortcuts: [],
    recentVisits: [],
    productFilter: "all",
    taskFilter: "all",
  };
}

function migrateTabs(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((tab) => typeof tab === "object" && tab !== null
    ? { ...tab, pinned: false, taskStatus: null }
    : tab);
}

function migrateConsoleHomeTabs(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((tab) => {
    if (typeof tab !== "object" || tab === null) return tab;
    const url = Reflect.get(tab, "url");
    if (typeof url !== "string") return tab;
    try {
      return normalizeConsoleUrl(url) === CONSOLE_HOME_URL
        ? { ...tab, product: "aliyun", regionId: null }
        : tab;
    } catch {
      return tab;
    }
  });
}

export interface FileSnapshotStoreOptions {
  filePath: string;
  fileSystem?: PersistenceFileSystem;
  migrate?: WorkspaceMigration;
}

function persistedSchemaVersion(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return Reflect.get(value, "schemaVersion");
}

function normalizeRegionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((regionId): regionId is string =>
    typeof regionId === "string" && isKnownRegion(regionId),
  ))];
}

function normalizeProducts(value: unknown): ConfigurableProduct[] {
  if (!Array.isArray(value)) return [...PRODUCTS];
  const products = [...new Set(value)].filter((product): product is ConfigurableProduct =>
    ConfigurableProductSchema.safeParse(product).success,
  );
  return products.length > 0 ? products : [...PRODUCTS];
}

function createProductRegionIds(regionIds: readonly string[]): ProductRegionIds {
  const mseRegionIds = regionIds.filter((regionId): regionId is (typeof MSE_REGION_IDS)[number] =>
    MSE_REGION_IDS.some((candidate) => candidate === regionId),
  );
  return {
    ack: [...regionIds],
    kafka: [...regionIds],
    mse: mseRegionIds.length > 0 ? mseRegionIds : ["cn-beijing"],
  };
}

export class FileSnapshotStore implements SnapshotStore {
  readonly #filePath: string;
  readonly #fileSystem: PersistenceFileSystem;
  readonly #migrate?: WorkspaceMigration;
  #pendingWrite: Promise<void> = Promise.resolve();

  constructor(options: FileSnapshotStoreOptions) {
    this.#filePath = options.filePath;
    this.#fileSystem = options.fileSystem ?? nodeFileSystem;
    this.#migrate = options.migrate ?? migrateWorkspaceSnapshot;
  }

  async load(): Promise<WorkspaceSnapshot> {
    let contents: string;

    try {
      contents = await this.#fileSystem.readFile(this.#filePath);
    } catch (error) {
      if (isMissingFile(error)) {
        return createDefaultSnapshot();
      }
      throw error;
    }

    try {
      let value: unknown = JSON.parse(contents);
      if (persistedSchemaVersion(value) !== CURRENT_SCHEMA_VERSION) {
        if (!this.#migrate) {
          return this.#recoverUnreadableSnapshot();
        }
        value = await this.#migrate(value, CURRENT_SCHEMA_VERSION);
      }

      return WorkspaceSnapshotSchema.parse(value);
    } catch {
      return this.#recoverUnreadableSnapshot();
    }
  }

  save(snapshot: WorkspaceSnapshot): Promise<void> {
    const validatedSnapshot = WorkspaceSnapshotSchema.parse(snapshot);
    const serializedSnapshot = `${JSON.stringify(validatedSnapshot, null, 2)}\n`;

    const write = this.#pendingWrite.then(() =>
      writePrivateFileAtomically(this.#filePath, serializedSnapshot, this.#fileSystem),
    );
    this.#pendingWrite = write.catch(() => undefined);
    return write;
  }

  async #recoverUnreadableSnapshot(): Promise<WorkspaceSnapshot> {
    await this.#fileSystem.rename(
      this.#filePath,
      `${this.#filePath}.${randomUUID()}.backup`,
    );
    return { ...createDefaultSnapshot(), notice: RECOVERY_NOTICE };
  }
}

export function createFileSnapshotStore(
  options: FileSnapshotStoreOptions,
): SnapshotStore {
  return new FileSnapshotStore(options);
}
