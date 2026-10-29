import type { ConfigurableProduct, Product } from "./model";
import { isRegionalProduct } from "./products";

declare const __OPSDOCK_E2E__: boolean;

const testNavigationCompiled =
  typeof __OPSDOCK_E2E__ !== "undefined" && __OPSDOCK_E2E__;

const TRACKING_QUERY_KEYS = new Set(["spm", "scm", "from", "source"]);

export interface ConsoleTarget {
  product: Product;
  regionId: string | null;
  url: string;
}

const DMS_CONSOLE_HOSTS = new Set([
  "dms.aliyun.com",
  "dmsnext.console.aliyun.com",
]);
const CODEUP_CONSOLE_HOSTS = new Set([
  "codeup.aliyun.com",
  "flow.aliyun.com",
]);
const SLS_CONSOLE_HOST = "sls.console.aliyun.com";
const MSE_CONSOLE_HOST = "mse.console.aliyun.com";
const ALIYUN_CONSOLE_HOSTS = new Set([
  "ecs.console.aliyun.com",
  "rds.console.aliyun.com",
  "rdsnext.console.aliyun.com",
  "oss.console.aliyun.com",
  "cloudmonitor.console.aliyun.com",
  "home.console.aliyun.com",
]);
export const CONSOLE_HOME_URL = "https://home.console.aliyun.com/home/dashboard/ProductAndService";

export function buildConsoleEntryUrl(product: ConfigurableProduct, regionId: string | null): string {
  if (product === "dms") return "https://dms.aliyun.com/";
  if (product === "codeup") return "https://codeup.aliyun.com/";
  if (product === "sls") return "https://sls.console.aliyun.com/lognext/profile";
  if (!regionId) throw new Error("该产品需要地域");
  if (product === "ack") {
    return `https://cs.console.aliyun.com/#/k8s/cluster/list?region=${encodeURIComponent(regionId)}`;
  }
  if (product === "mse") {
    return `https://mse.console.aliyun.com/#/InstanceList?region=${encodeURIComponent(regionId)}`;
  }
  return `https://kafka.console.aliyun.com/region/${encodeURIComponent(regionId)}/instances`;
}

export function parseProduct(urlValue: string): Product | null {
  try {
    const url = new URL(urlValue);
    if (url.hostname === "cs.console.aliyun.com") return "ack";
    if (url.hostname === "kafka.console.aliyun.com") return "kafka";
    if (DMS_CONSOLE_HOSTS.has(url.hostname)) return "dms";
    if (CODEUP_CONSOLE_HOSTS.has(url.hostname)) return "codeup";
    if (url.hostname === SLS_CONSOLE_HOST) return "sls";
    if (url.hostname === MSE_CONSOLE_HOST) return "mse";
    if (ALIYUN_CONSOLE_HOSTS.has(url.hostname)) return "aliyun";
    return null;
  } catch {
    return null;
  }
}

export function isSupportedConsoleHost(hostname: string): boolean {
  return hostname === "cs.console.aliyun.com"
    || hostname === "kafka.console.aliyun.com"
    || DMS_CONSOLE_HOSTS.has(hostname)
    || CODEUP_CONSOLE_HOSTS.has(hostname)
    || hostname === SLS_CONSOLE_HOST
    || hostname === MSE_CONSOLE_HOST
    || ALIYUN_CONSOLE_HOSTS.has(hostname);
}

export function parseRegionId(urlValue: string): string | null {
  try {
    const url = new URL(urlValue);
    if (
      DMS_CONSOLE_HOSTS.has(url.hostname)
      || CODEUP_CONSOLE_HOSTS.has(url.hostname)
      || url.hostname === SLS_CONSOLE_HOST
    ) return null;
    const directRegion = url.searchParams.get("region");
    if (directRegion) return directRegion;

    if (url.hostname === "cs.console.aliyun.com" || url.hostname === MSE_CONSOLE_HOST) {
      const questionIndex = url.hash.indexOf("?");
      if (questionIndex >= 0) {
        const hashParams = new URLSearchParams(url.hash.slice(questionIndex + 1));
        return hashParams.get("region");
      }
    }

    if (url.hostname === "kafka.console.aliyun.com") {
      const match = url.pathname.match(/\/region\/([^/]+)/);
      return match?.[1] ? decodeURIComponent(match[1]) : null;
    }
    return null;
  } catch {
    return null;
  }
}

function cleanParams(params: URLSearchParams): string {
  const entries = [...params.entries()]
    .filter(([key]) => !TRACKING_QUERY_KEYS.has(key.toLowerCase()))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyOrder = leftKey.localeCompare(rightKey);
      return keyOrder === 0 ? leftValue.localeCompare(rightValue) : keyOrder;
    });
  return new URLSearchParams(entries).toString();
}

export function normalizeConsoleUrl(urlValue: string): string {
  const url = new URL(urlValue);
  const search = cleanParams(url.searchParams);
  url.search = search ? `?${search}` : "";

  if (url.hash.includes("?")) {
    const [route, query = ""] = url.hash.slice(1).split("?", 2);
    const cleanedHashQuery = cleanParams(new URLSearchParams(query));
    url.hash = cleanedHashQuery ? `#${route}?${cleanedHashQuery}` : `#${route}`;
  }

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

export function parseConsoleTarget(urlValue: string): ConsoleTarget | null {
  const product = parseProduct(urlValue);
  if (product && !isRegionalProduct(product)) return { product, regionId: null, url: urlValue };
  const regionId = parseRegionId(urlValue);
  if (!product || !regionId) return null;
  return { product, regionId, url: urlValue };
}

export function parseObservedConsoleTarget(
  urlValue: string,
  allowTestServer = false,
): ConsoleTarget | null {
  const target = parseConsoleTarget(urlValue);
  if (target || !testNavigationCompiled || !allowTestServer) return target;

  try {
    const url = new URL(urlValue);
    const productMatch = url.pathname.match(/^\/(ack|kafka|mse|dms|codeup|sls)(?:\/|$)/);
    if (!productMatch) return null;
    const product = productMatch[1] as Product;
    const regionId = isRegionalProduct(product) ? url.searchParams.get("region") : null;
    if (isRegionalProduct(product) && !regionId) return null;
    return { product, regionId, url: urlValue };
  } catch {
    return null;
  }
}

const TRAILING_URL_PUNCTUATION = /[.,;:!?)\]}\u3001\u3002\uFF0C\uFF1B\uFF1A\uFF01\uFF1F\uFF09\u3011\u300B\u300D\u300F\u201D\u2019]+$/u;

export function extractConsoleUrls(text: string, max = 10): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const limit = Number.isFinite(max)
    ? Math.max(0, Math.min(10, Math.floor(max)))
    : 10;
  if (limit === 0) return urls;

  for (const match of text.matchAll(/https?:\/\/[^\s<>"'\u201C\u201D\u2018\u2019]+/giu)) {
    const candidate = match[0].replace(TRAILING_URL_PUNCTUATION, "");
    try {
      const url = new URL(candidate);
      if (!parseConsoleTarget(url.toString())) continue;
      if (url.protocol === "http:") url.protocol = "https:";
      const secureUrl = url.toString();
      const normalized = normalizeConsoleUrl(secureUrl);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      urls.push(secureUrl);
      if (urls.length === limit) break;
    } catch {
      // Ignore malformed URL-like text.
    }
  }
  return urls;
}
