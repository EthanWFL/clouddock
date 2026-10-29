import type { ConfigurableProduct, Product, ProductRegionIds } from "./model";

export const REGIONAL_PRODUCTS = ["ack", "kafka", "mse"] as const satisfies readonly ConfigurableProduct[];
export const GLOBAL_PRODUCTS = ["dms", "codeup", "sls"] as const satisfies readonly ConfigurableProduct[];
export const PRODUCTS = [...REGIONAL_PRODUCTS, ...GLOBAL_PRODUCTS] as const satisfies readonly ConfigurableProduct[];
export const MSE_REGION_IDS = ["cn-beijing", "cn-shanghai"] as const;
export type RegionalProduct = (typeof REGIONAL_PRODUCTS)[number];

export function isRegionalProduct(
  product: Product,
): product is (typeof REGIONAL_PRODUCTS)[number] {
  return REGIONAL_PRODUCTS.some((candidate) => candidate === product);
}

export function isProductAvailableInRegion(product: Product, regionId: string): boolean {
  return product !== "mse"
    || MSE_REGION_IDS.some((candidate) => candidate === regionId);
}

export function getProductRegionIds(
  product: Product,
  regionIds: readonly string[] | ProductRegionIds,
): string[] {
  if (!isRegionalProduct(product)) return [];
  if (Array.isArray(regionIds)) {
    return regionIds.filter((regionId) => isProductAvailableInRegion(product, regionId));
  }
  const productRegionIds = regionIds as ProductRegionIds;
  return productRegionIds[product].filter((regionId) => isProductAvailableInRegion(product, regionId));
}
