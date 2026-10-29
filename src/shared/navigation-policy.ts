import {
  isSupportedConsoleHost,
  parseConsoleTarget,
  parseObservedConsoleTarget,
} from "./console-url";
import type { ConsoleTarget } from "./console-url";

declare const __OPSDOCK_E2E__: boolean;

const testNavigationCompiled =
  typeof __OPSDOCK_E2E__ !== "undefined" && __OPSDOCK_E2E__;

const AUTH_HOSTS = new Set([
  "account.aliyun.com",
  "signin.aliyun.com",
  "login.aliyun.com",
  "passport.aliyun.com",
  "account-devops.aliyun.com",
]);

export type NavigationSource = "current" | "popup";

export type NavigationDecision =
  | { kind: "allow-current" }
  | { kind: "load-secure-url"; url: string }
  | { kind: "open-console-tab"; target: ConsoleTarget }
  | { kind: "block"; reason: string };

export interface NavigationPolicyOptions {
  allowTestServer?: boolean;
}

export function decideNavigation(
  urlValue: string,
  source: NavigationSource,
  options: NavigationPolicyOptions = {},
): NavigationDecision {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return { kind: "block", reason: "链接格式无效" };
  }

  if (
    testNavigationCompiled &&
    options.allowTestServer &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname)
  ) {
    return source === "current"
      ? { kind: "allow-current" }
      : {
          kind: "open-console-tab",
          target: { product: "ack", regionId: "cn-beijing", url: urlValue },
        };
  }

  if (
    url.protocol === "http:"
    && (isSupportedConsoleHost(url.hostname) || AUTH_HOSTS.has(url.hostname))
  ) {
    url.protocol = "https:";
    return { kind: "load-secure-url", url: url.toString() };
  }

  if (url.protocol !== "https:") {
    return { kind: "block", reason: "只允许 HTTPS 页面链接" };
  }

  if (isSupportedConsoleHost(url.hostname)) {
    if (source === "current") return { kind: "allow-current" };
    const target = parseConsoleTarget(urlValue);
    return target
      ? { kind: "open-console-tab", target }
      : { kind: "allow-current" };
  }

  if (AUTH_HOSTS.has(url.hostname)) {
    return { kind: "allow-current" };
  }

  return { kind: "allow-current" };
}

export function isAllowedConsoleHost(hostname: string): boolean {
  return isSupportedConsoleHost(hostname);
}

export function isAllowedAuthHost(hostname: string): boolean {
  return AUTH_HOSTS.has(hostname);
}

export function isTrustedConsoleDownloadSource(
  urlValue: string,
  options: NavigationPolicyOptions = {},
): boolean {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return false;
  }

  if (url.protocol === "https:") {
    return isAllowedConsoleHost(url.hostname);
  }

  if (
    !testNavigationCompiled
    || !options.allowTestServer
    || url.protocol !== "http:"
    || !["127.0.0.1", "localhost"].includes(url.hostname)
  ) {
    return false;
  }

  return parseObservedConsoleTarget(urlValue, true) !== null;
}
