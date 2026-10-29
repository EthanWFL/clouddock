import {
  GLOBAL_PRODUCTS,
  getProductRegionIds,
  isRegionalProduct,
  PRODUCTS,
  REGIONAL_PRODUCTS,
} from "./products";
import type { ModuleShortcut, Product, WorkspaceTab } from "./model";
import { normalizeConsoleUrl } from "./console-url";
import { getRegionShortName } from "./regions";

export { GLOBAL_PRODUCTS, getProductRegionIds, isRegionalProduct, PRODUCTS, REGIONAL_PRODUCTS };

export interface GlobalProductEntry {
  product: (typeof GLOBAL_PRODUCTS)[number];
  label: string;
  url?: string;
}

export const GLOBAL_PRODUCT_ENTRIES: readonly GlobalProductEntry[] = [
  { product: "dms", label: "数据管理" },
  { product: "codeup", label: "代码管理" },
  { product: "sls", label: "日志服务" },
];

export function getTabModuleShortcut(
  tab: Pick<WorkspaceTab, "product" | "url" | "moduleShortcutId">,
  shortcuts: readonly ModuleShortcut[],
): ModuleShortcut | undefined {
  const candidates = shortcuts.filter((shortcut) => shortcut.product === tab.product);
  const normalizedUrl = normalizeConsoleUrl(tab.url);
  return candidates.find((shortcut) => normalizeConsoleUrl(shortcut.url) === normalizedUrl)
    ?? candidates.find((shortcut) => shortcut.id === tab.moduleShortcutId);
}

export function productLabel(product: Product): string {
  switch (product) {
    case "ack":
      return "ACK";
    case "kafka":
      return "Kafka";
    case "mse":
      return "MSE";
    case "dms":
      return "DMS";
    case "codeup":
      return "Codeup";
    case "sls":
      return "SLS";
    case "aliyun":
      return "阿里云";
  }
}

export function getProductContextLabel(product: Product, regionId: string | null): string {
  const label = productLabel(product);
  return regionId ? `${label} · ${getRegionShortName(regionId)}` : label;
}

export function getTabDisplayTitle(tab: WorkspaceTab): string {
  return tab.regionId ? `${tab.title} · ${getRegionShortName(tab.regionId)}` : tab.title;
}
