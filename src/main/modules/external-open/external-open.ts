import {
  isSupportedConsoleHost,
  parseConsoleTarget,
  parseProduct,
} from "../../../shared/console-url";
import type { ConsoleTarget } from "../../../shared/console-url";
import { isAllowedAuthHost } from "../../../shared/navigation-policy";

export const EXTERNAL_OPEN_SCHEMES = ["clouddock", "opsdock"] as const;
export const EXTERNAL_OPEN_ALLOWLIST_ENV = "CLOUDDOCK_URL_ALLOWLIST";

export interface ExternalOpenProtocolClient {
  readonly isPackaged: boolean;
  setAsDefaultProtocolClient(scheme: string): boolean;
}

export function registerExternalOpenProtocols(
  client: ExternalOpenProtocolClient,
): string[] {
  if (!client.isPackaged) return [];
  return EXTERNAL_OPEN_SCHEMES.filter(
    (scheme) => !client.setAsDefaultProtocolClient(scheme),
  );
}

const MAX_EXTERNAL_URL_LENGTH = 4_096;
const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type ExternalOpenHostRule =
  | { kind: "exact"; hostname: string }
  | { kind: "subdomains"; hostname: string };

export type ExternalOpenResult =
  | { ok: true; target: ConsoleTarget }
  | { ok: false; reason: string };

const DEFAULT_EXTERNAL_OPEN_HOST_RULES: readonly ExternalOpenHostRule[] = [
  { kind: "subdomains", hostname: "aliyun.com" },
];

export function findExternalOpenUrls(commandLine: readonly string[]): string[] {
  return commandLine.filter((value) => EXTERNAL_OPEN_SCHEMES.some(
    (scheme) => value.toLowerCase().startsWith(`${scheme}://`),
  ));
}

function normalizeHostname(value: string): string | null {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  return HOSTNAME_PATTERN.test(hostname) ? hostname : null;
}

export function parseExternalOpenHostRules(value: string | undefined): ExternalOpenHostRule[] {
  if (!value) return [];
  const rules: ExternalOpenHostRule[] = [];
  const seen = new Set<string>();
  for (const rawRule of value.split(",")) {
    const trimmed = rawRule.trim();
    const subdomains = trimmed.startsWith("*.");
    const hostname = normalizeHostname(subdomains ? trimmed.slice(2) : trimmed);
    if (!hostname) continue;
    const key = `${subdomains ? "subdomains" : "exact"}:${hostname}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ kind: subdomains ? "subdomains" : "exact", hostname });
  }
  return rules;
}

function matchesRule(hostname: string, rule: ExternalOpenHostRule): boolean {
  if (rule.kind === "exact") return hostname === rule.hostname;
  return hostname !== rule.hostname && hostname.endsWith(`.${rule.hostname}`);
}

function isAllowedTargetHost(hostname: string, rules: readonly ExternalOpenHostRule[]): boolean {
  return isSupportedConsoleHost(hostname)
    || isAllowedAuthHost(hostname)
    || DEFAULT_EXTERNAL_OPEN_HOST_RULES.some((rule) => matchesRule(hostname, rule))
    || rules.some((rule) => matchesRule(hostname, rule));
}

export function parseExternalOpenUrl(
  value: string,
  rules: readonly ExternalOpenHostRule[] = [],
): ExternalOpenResult {
  if (value.length > MAX_EXTERNAL_URL_LENGTH * 2) {
    return { ok: false, reason: "CloudDock 跳转链接过长" };
  }

  let requestUrl: URL;
  try {
    requestUrl = new URL(value);
  } catch {
    return { ok: false, reason: "CloudDock 跳转链接格式无效" };
  }

  if (!EXTERNAL_OPEN_SCHEMES.some((scheme) => requestUrl.protocol === `${scheme}:`)) {
    return { ok: false, reason: "不支持的 CloudDock 跳转协议" };
  }
  if (
    requestUrl.hostname !== "open"
    || !["", "/"].includes(requestUrl.pathname)
    || requestUrl.username
    || requestUrl.password
    || requestUrl.port
    || requestUrl.hash
  ) {
    return { ok: false, reason: "CloudDock 跳转入口无效" };
  }

  const keys = [...requestUrl.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "url") {
    return { ok: false, reason: "CloudDock 跳转只接受一个 url 参数" };
  }
  const targetValue = requestUrl.searchParams.get("url");
  if (!targetValue || targetValue.length > MAX_EXTERNAL_URL_LENGTH) {
    return { ok: false, reason: "目标链接为空或过长" };
  }

  return parseExternalTargetUrl(targetValue, rules);
}

export function parseExternalTargetUrl(
  value: string,
  rules: readonly ExternalOpenHostRule[] = [],
): ExternalOpenResult {
  if (!value || value.length > MAX_EXTERNAL_URL_LENGTH) {
    return { ok: false, reason: "目标链接为空或过长" };
  }
  let targetUrl: URL;
  try {
    targetUrl = new URL(value);
  } catch {
    return { ok: false, reason: "目标链接格式无效" };
  }
  if (targetUrl.protocol !== "https:") {
    return { ok: false, reason: "外部跳转只允许 HTTPS 目标" };
  }
  if (targetUrl.username || targetUrl.password || targetUrl.port) {
    return { ok: false, reason: "目标链接不能包含凭据或自定义端口" };
  }
  if (!isAllowedTargetHost(targetUrl.hostname, rules)) {
    return { ok: false, reason: `目标主机不在白名单：${targetUrl.hostname}` };
  }

  const target = parseConsoleTarget(targetUrl.toString());
  if (target) return { ok: true, target };
  if (parseProduct(targetUrl.toString())) {
    return { ok: false, reason: "该控制台链接缺少可识别的地域" };
  }
  return {
    ok: true,
    target: { product: "aliyun", regionId: null, url: targetUrl.toString() },
  };
}
