export const STORAGE_KEY = "openRules";
export const MAX_RULES = 100;

const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function normalizeHost(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  const wildcard = trimmed.startsWith("*.");
  const hostname = (wildcard ? trimmed.slice(2) : trimmed).replace(/\.$/, "");
  if (!HOST_PATTERN.test(hostname)) {
    throw new Error("域名必须是 example.com 或 *.example.com 格式");
  }
  return `${wildcard ? "*." : ""}${hostname}`;
}

function normalizePathPrefix(value) {
  const prefix = String(value ?? "").trim() || "/";
  if (!prefix.startsWith("/") || prefix.includes("?") || prefix.includes("#")) {
    throw new Error("路径前缀必须以 / 开头，且不能包含查询参数或片段");
  }
  return prefix;
}

export function normalizeRule(value, fallbackId = "") {
  if (!value || typeof value !== "object") throw new Error("规则格式无效");
  return {
    id: String(value.id || fallbackId).slice(0, 80),
    enabled: value.enabled !== false,
    host: normalizeHost(value.host),
    pathPrefix: normalizePathPrefix(value.pathPrefix),
  };
}

export function sanitizeRules(value) {
  if (!Array.isArray(value)) return [];
  const rules = [];
  const ids = new Set();
  for (let index = 0; index < value.length && rules.length < MAX_RULES; index += 1) {
    try {
      const rule = normalizeRule(value[index], `rule-${index + 1}`);
      if (!rule.id || ids.has(rule.id)) continue;
      ids.add(rule.id);
      rules.push(rule);
    } catch {
      // Invalid stored rules are ignored rather than widening access.
    }
  }
  return rules;
}

export async function loadRules(storageArea = chrome.storage.sync) {
  const stored = await storageArea.get(STORAGE_KEY);
  return sanitizeRules(stored[STORAGE_KEY]);
}

export async function saveRules(rules, storageArea = chrome.storage.sync) {
  const safeRules = sanitizeRules(rules);
  await storageArea.set({ [STORAGE_KEY]: safeRules });
  return safeRules;
}

function matchesHost(hostname, pattern) {
  if (!pattern.startsWith("*.")) return hostname === pattern;
  const suffix = pattern.slice(2);
  return hostname !== suffix && hostname.endsWith(`.${suffix}`);
}

export function matchPageUrl(urlValue, rules) {
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    return { ok: false, reason: "当前页面地址无效" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "只支持 HTTPS 页面" };
  if (url.username || url.password || url.port) {
    return { ok: false, reason: "页面地址包含不允许的凭据或端口" };
  }
  const rule = sanitizeRules(rules).find((candidate) => (
    candidate.enabled
    && matchesHost(url.hostname, candidate.host)
    && url.pathname.startsWith(candidate.pathPrefix)
  ));
  return rule
    ? { ok: true, url: url.toString(), rule }
    : { ok: false, reason: "当前页面不匹配已启用的域名和路径规则" };
}

export function buildCloudDockUrl(urlValue) {
  return `clouddock://open?url=${encodeURIComponent(urlValue)}`;
}
