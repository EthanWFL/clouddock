import { describe, expect, it } from "vitest";

import { formatConsoleLoadError, formatConsoleLoadFailure } from "../../src/main/modules/console-views/load-error-message";

describe("formatConsoleLoadError", () => {
  it("ignores navigation cancellation and preserves the same mapped error for promise rejections", () => {
    expect(formatConsoleLoadFailure(Object.assign(new Error("cancelled"), { errno: -3 }))).toBeNull();
    expect(formatConsoleLoadFailure(Object.assign(new Error("cancelled"), { code: "ERR_ABORTED" }))).toBeNull();
    expect(formatConsoleLoadFailure(Object.assign(new Error("private URL"), { errno: -105, code: "ERR_NAME_NOT_RESOLVED" })))
      .toBe(formatConsoleLoadError(-105, "ERR_NAME_NOT_RESOLVED"));
    expect(formatConsoleLoadFailure(new Error("https://example.com/private-token"))).not.toContain("private-token");
  });

  it.each([
    [-106, "网络连接已断开", "网络、VPN 或代理"],
    [-105, "无法解析控制台域名", "DNS 或网络设置"],
    [-102, "控制台拒绝连接", "代理、防火墙或服务状态"],
    [-118, "连接控制台超时", "网络或代理设置"],
  ] as const)("maps Chromium network error %i to an actionable message", (code, cause, action) => {
    const message = formatConsoleLoadError(code, "ignored Chromium description");

    expect(message).toContain(cause);
    expect(message).toContain(action);
    expect(message).toContain(`错误码：${code}`);
    expect(message).not.toContain("ignored Chromium description");
  });

  it.each([-200, -201, -202, -207, -218, -219])(
    "maps certificate error %i to the TLS guidance",
    (code) => {
      expect(formatConsoleLoadError(code, "ERR_CERT_FAILURE")).toBe(
        `TLS 或证书校验失败，请检查系统时间、代理证书或网络环境后重试（错误码：${code}）`,
      );
    },
  );

  it.each([-107, -113, -150, -156, -159])(
    "maps common TLS error %i to the TLS guidance",
    (code) => {
      expect(formatConsoleLoadError(code, "ERR_SSL_FAILURE")).toContain(
        `TLS 或证书校验失败，请检查系统时间、代理证书或网络环境后重试（错误码：${code}）`,
      );
    },
  );

  it("sanitizes control and bidirectional characters in an unknown description", () => {
    expect(
      formatConsoleLoadError(-777, " \u202eERR_UNKNOWN\n\twith\u0000 details "),
    ).toBe("页面加载失败：ERR_UNKNOWN with details（错误码：-777）");
  });

  it("safely truncates a long unknown description", () => {
    expect(formatConsoleLoadError(-778, "A".repeat(200))).toBe(
      `页面加载失败：${"A".repeat(120)}...（错误码：-778）`,
    );
  });

  it("uses a safe fallback when an unknown description is empty after sanitization", () => {
    expect(formatConsoleLoadError(-779, "\n\t\u0000")).toBe(
      "页面加载失败：控制台页面加载失败（错误码：-779）",
    );
  });
});
