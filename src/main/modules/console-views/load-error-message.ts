const MAX_UNKNOWN_DESCRIPTION_LENGTH = 120;

const NETWORK_ERROR_MESSAGES = new Map<number, string>([
  [-106, "网络连接已断开，请检查网络、VPN 或代理后刷新"],
  [-105, "无法解析控制台域名，请检查 DNS 或网络设置后刷新"],
  [-102, "控制台拒绝连接，请检查代理、防火墙或服务状态后刷新"],
  [-118, "连接控制台超时，请检查网络或代理设置后重试"],
]);

const TLS_ERROR_CODES = new Set([-107, -113, -150, -156, -159]);
const CERTIFICATE_ERROR_START = -200;
const CERTIFICATE_ERROR_END = -219;

function withErrorCode(message: string, errorCode: number): string {
  return `${message}（错误码：${errorCode}）`;
}

function sanitizeDescription(description: string): string {
  const sanitized = description
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const codePoints = Array.from(sanitized);
  if (codePoints.length <= MAX_UNKNOWN_DESCRIPTION_LENGTH) return sanitized;
  return `${codePoints.slice(0, MAX_UNKNOWN_DESCRIPTION_LENGTH).join("")}...`;
}

export function formatConsoleLoadError(errorCode: number, errorDescription: string): string {
  const networkMessage = NETWORK_ERROR_MESSAGES.get(errorCode);
  if (networkMessage) return withErrorCode(networkMessage, errorCode);

  if (
    TLS_ERROR_CODES.has(errorCode) ||
    (errorCode <= CERTIFICATE_ERROR_START && errorCode >= CERTIFICATE_ERROR_END)
  ) {
    return withErrorCode(
      "TLS 或证书校验失败，请检查系统时间、代理证书或网络环境后重试",
      errorCode,
    );
  }

  const description = sanitizeDescription(errorDescription) || "控制台页面加载失败";
  return withErrorCode(`页面加载失败：${description}`, errorCode);
}

export function formatConsoleLoadFailure(error: unknown): string | null {
  const errno = typeof error === "object" && error !== null && "errno" in error ? error.errno : undefined;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (errno === -3 || code === "ERR_ABORTED") return null;
  if (typeof errno === "number") {
    return formatConsoleLoadError(errno, typeof code === "string" ? code : "控制台页面加载失败");
  }
  return "控制台页面加载失败，请检查网络后重试";
}
