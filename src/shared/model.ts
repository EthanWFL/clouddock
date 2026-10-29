import { z } from "zod";
import { DEFAULT_REGION_IDS, REGIONS } from "./regions";
import { MSE_REGION_IDS, PRODUCTS } from "./products";

export const ConfigurableProductSchema = z.enum(["ack", "kafka", "mse", "dms", "codeup", "sls"]);
export type ConfigurableProduct = z.infer<typeof ConfigurableProductSchema>;
export const ProductSchema = z.enum(["ack", "kafka", "mse", "dms", "codeup", "sls", "aliyun"]);
export type Product = z.infer<typeof ProductSchema>;
export const WORKSPACE_SCHEMA_VERSION = 6;
export const MAX_RECENT_VISITS = 50;

export const TabLoadStateSchema = z.enum([
  "deferred",
  "loading",
  "ready",
  "error",
  "crashed",
]);
export type TabLoadState = z.infer<typeof TabLoadStateSchema>;

export const TaskStatusSchema = z.enum(["todo", "doing", "done"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export const ProductFilterSchema = z.union([ProductSchema, z.literal("all")]);
export type ProductFilter = z.infer<typeof ProductFilterSchema>;
export const TaskFilterSchema = z.union([TaskStatusSchema, z.enum(["none", "all"])]);
export type TaskFilter = z.infer<typeof TaskFilterSchema>;
export const BatchCloseScopeSchema = z.enum(["others", "completed", "unpinned"]);
export type BatchCloseScope = z.infer<typeof BatchCloseScopeSchema>;

export const WorkspaceTabSchema = z.object({
  id: z.string().min(1),
  product: ProductSchema,
  regionId: z.string().min(1).nullable(),
  url: z.string().url(),
  title: z.string().min(1),
  moduleShortcutId: z.string().min(1).optional(),
  createdAt: z.number().int().nonnegative(),
  lastActiveAt: z.number().int().nonnegative(),
  pinned: z.boolean(),
  taskStatus: TaskStatusSchema.nullable(),
  loadState: TabLoadStateSchema.default("deferred"),
  canGoBack: z.boolean().default(false),
  canGoForward: z.boolean().default(false),
  isAuthenticating: z.boolean().optional(),
  externalHostname: z.string().min(1).optional(),
  errorMessage: z.string().optional(),
});
export type WorkspaceTab = z.infer<typeof WorkspaceTabSchema>;

export const FavoriteSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  product: ProductSchema,
  regionId: z.string().min(1).nullable(),
  url: z.string().url(),
  createdAt: z.number().int().nonnegative(),
});
export type Favorite = z.infer<typeof FavoriteSchema>;

export const ModuleShortcutSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  product: z.enum(["codeup", "sls"]),
  url: z.string().url(),
  createdAt: z.number().int().nonnegative(),
});
export type ModuleShortcut = z.infer<typeof ModuleShortcutSchema>;

export const RecentVisitSchema = z.object({
  product: ProductSchema,
  regionId: z.string().min(1).nullable(),
  url: z.string().url(),
  title: z.string().min(1),
  visitedAt: z.number().int().nonnegative(),
});
export type RecentVisit = z.infer<typeof RecentVisitSchema>;

export const WindowBoundsSchema = z.object({
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  width: z.number().int().min(1024).max(10000),
  height: z.number().int().min(680).max(10000),
});
export type WindowBounds = z.infer<typeof WindowBoundsSchema>;

export const ProductRegionIdsSchema = z.object({
  ack: z.array(z.string()).max(REGIONS.length),
  kafka: z.array(z.string()).max(REGIONS.length),
  mse: z.array(z.enum(MSE_REGION_IDS)).max(MSE_REGION_IDS.length),
});
export type ProductRegionIds = z.infer<typeof ProductRegionIdsSchema>;

export const WorkspaceSnapshotSchema = z.object({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  tabs: z.array(WorkspaceTabSchema),
  activeTabId: z.string().nullable(),
  favorites: z.array(FavoriteSchema),
  moduleShortcuts: z.array(ModuleShortcutSchema),
  recentVisits: z.array(RecentVisitSchema).max(MAX_RECENT_VISITS),
  selectedProducts: z.array(ConfigurableProductSchema).min(1).max(PRODUCTS.length),
  productRegionIds: ProductRegionIdsSchema,
  recentlyClosedTabs: z.array(WorkspaceTabSchema).max(10),
  sidebarCollapsed: z.boolean(),
  onboardingComplete: z.boolean(),
  productFilter: ProductFilterSchema,
  taskFilter: TaskFilterSchema,
  windowBounds: WindowBoundsSchema,
  notice: z.string().nullable().default(null),
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

export function createDefaultSnapshot(): WorkspaceSnapshot {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    tabs: [],
    activeTabId: null,
    favorites: [],
    moduleShortcuts: [],
    recentVisits: [],
    selectedProducts: [...PRODUCTS],
    productRegionIds: {
      ack: [...DEFAULT_REGION_IDS],
      kafka: [...DEFAULT_REGION_IDS],
      mse: ["cn-beijing"],
    },
    recentlyClosedTabs: [],
    sidebarCollapsed: false,
    onboardingComplete: false,
    productFilter: "all",
    taskFilter: "all",
    windowBounds: { width: 1280, height: 800 },
    notice: null,
  };
}

export const WorkspaceCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("complete-onboarding"),
    selectedProducts: z.array(ConfigurableProductSchema).min(1).max(PRODUCTS.length),
    productRegionIds: ProductRegionIdsSchema,
    initialProduct: ConfigurableProductSchema.default("ack"),
  }),
  z.object({ type: z.literal("open-entry"), product: ConfigurableProductSchema, regionId: z.string().min(1).nullable() }),
  z.object({ type: z.literal("open-console-home") }),
  z.object({ type: z.literal("open-pasted-url"), url: z.string().trim().max(4_096).url() }),
  z.object({
    type: z.literal("open-pasted-urls"),
    urls: z.array(z.string().trim().max(4_096).url()).min(1).max(10),
  }),
  z.object({
    type: z.literal("open-url"),
    product: ProductSchema,
    regionId: z.string().min(1).nullable(),
    url: z.string().url(),
    title: z.string().optional(),
    sourceTabId: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("activate-tab"), tabId: z.string() }),
  z.object({ type: z.literal("set-tab-pinned"), tabId: z.string(), pinned: z.boolean() }),
  z.object({
    type: z.literal("set-tab-task-status"),
    tabId: z.string(),
    taskStatus: TaskStatusSchema.nullable(),
  }),
  z.object({
    type: z.literal("move-tab"),
    tabId: z.string().min(1),
    toIndex: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("close-tab"), tabId: z.string() }),
  z.object({ type: z.literal("reopen-closed-tab"), tabId: z.string().optional() }),
  z.object({ type: z.literal("close-tabs"), scope: BatchCloseScopeSchema }),
  z.object({
    type: z.literal("update-tab"),
    tabId: z.string(),
    url: z.string().url().optional(),
    target: z.object({ product: ProductSchema, regionId: z.string().min(1).nullable() }).optional(),
    title: z.string().optional(),
    loadState: TabLoadStateSchema.optional(),
    canGoBack: z.boolean().optional(),
    canGoForward: z.boolean().optional(),
    errorMessage: z.string().optional(),
  }),
  z.object({ type: z.literal("add-favorite"), tabId: z.string(), name: z.string().trim().min(1) }),
  z.object({ type: z.literal("rename-favorite"), favoriteId: z.string(), name: z.string().trim().min(1) }),
  z.object({ type: z.literal("move-favorite"), favoriteId: z.string().min(1), toIndex: z.number().int().nonnegative() }),
  z.object({ type: z.literal("remove-favorite"), favoriteId: z.string() }),
  z.object({ type: z.literal("restore-favorite"), favoriteId: z.string() }),
  z.object({ type: z.literal("add-module-shortcut"), tabId: z.string(), name: z.string().trim().min(1) }),
  z.object({ type: z.literal("rename-module-shortcut"), shortcutId: z.string(), name: z.string().trim().min(1) }),
  z.object({ type: z.literal("move-module-shortcut"), shortcutId: z.string().min(1), toIndex: z.number().int().nonnegative() }),
  z.object({ type: z.literal("remove-module-shortcut"), shortcutId: z.string() }),
  z.object({ type: z.literal("restore-module-shortcut"), shortcutId: z.string() }),
  z.object({
    type: z.literal("set-module-settings"),
    selectedProducts: z.array(ConfigurableProductSchema).min(1).max(PRODUCTS.length),
    productRegionIds: ProductRegionIdsSchema,
  }),
  z.object({
    type: z.literal("set-tab-filters"),
    productFilter: ProductFilterSchema,
    taskFilter: TaskFilterSchema,
  }),
  z.object({ type: z.literal("set-sidebar-collapsed"), collapsed: z.boolean() }),
  z.object({ type: z.literal("set-window-bounds"), bounds: WindowBoundsSchema }),
  z.object({ type: z.literal("set-notice"), notice: z.string().nullable() }),
  z.object({ type: z.literal("clear-console-tabs") }),
]);
export type WorkspaceCommand = z.infer<typeof WorkspaceCommandSchema>;

export type WorkspaceResult =
  | { ok: true }
  | { ok: false; error: string };

export {
  getTabDisplayTitle,
  productLabel,
} from "./workspace-display";
export {
  GLOBAL_PRODUCTS,
  getProductRegionIds,
  isProductAvailableInRegion,
  isRegionalProduct,
  MSE_REGION_IDS,
  PRODUCTS,
  REGIONAL_PRODUCTS,
} from "./products";
