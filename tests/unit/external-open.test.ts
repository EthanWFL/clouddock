import { describe, expect, it, vi } from "vitest";

import {
  findExternalOpenUrls,
  parseExternalOpenHostRules,
  parseExternalOpenUrl,
  registerExternalOpenProtocols,
} from "../../src/main/modules/external-open/external-open";

function externalUrl(target: string, scheme = "clouddock"): string {
  return `${scheme}://open?url=${encodeURIComponent(target)}`;
}

describe("external CloudDock URL handling", () => {
  it("does not let development or E2E Electron builds claim the app protocols", () => {
    const setAsDefaultProtocolClient = vi.fn(() => true);

    expect(registerExternalOpenProtocols({
      isPackaged: false,
      setAsDefaultProtocolClient,
    })).toEqual([]);
    expect(setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it("registers every app protocol in packaged builds and reports failures", () => {
    const setAsDefaultProtocolClient = vi.fn((scheme: string) => scheme === "clouddock");

    expect(registerExternalOpenProtocols({
      isPackaged: true,
      setAsDefaultProtocolClient,
    })).toEqual(["opsdock"]);
    expect(setAsDefaultProtocolClient.mock.calls).toEqual([
      ["clouddock"],
      ["opsdock"],
    ]);
  });

  it("extracts CloudDock links from cold-start and second-instance command lines", () => {
    expect(findExternalOpenUrls([
      "/Applications/CloudDock.app/Contents/MacOS/CloudDock",
      "--flag",
      "CLOUDDOCK://open?url=https%3A%2F%2Fcodeup.aliyun.com",
      "opsdock://open?url=https%3A%2F%2Fflow.aliyun.com",
      "https://example.com",
    ])).toEqual([
      "CLOUDDOCK://open?url=https%3A%2F%2Fcodeup.aliyun.com",
      "opsdock://open?url=https%3A%2F%2Fflow.aliyun.com",
    ]);
  });

  it.each(["clouddock", "opsdock"])("accepts %s for an exact supported console host", (scheme) => {
    expect(
      parseExternalOpenUrl(
        externalUrl(
          "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
          scheme,
        ),
      ),
    ).toEqual({
      ok: true,
      target: {
        product: "ack",
        regionId: "cn-beijing",
        url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
      },
    });
  });

  it("allows existing global Codeup targets by default", () => {
    expect(parseExternalOpenUrl(externalUrl("https://codeup.aliyun.com/org/repository/1"))).toEqual({
      ok: true,
      target: {
        product: "codeup",
        regionId: null,
        url: "https://codeup.aliyun.com/org/repository/1",
      },
    });
  });

  it.each([
    "account.aliyun.com",
    "signin.aliyun.com",
    "login.aliyun.com",
    "passport.aliyun.com",
    "account-devops.aliyun.com",
  ])("allows the existing trusted authentication host %s", (hostname) => {
    const target = `https://${hostname}/login.htm`;
    expect(parseExternalOpenUrl(externalUrl(target))).toEqual({
      ok: true,
      target: { product: "aliyun", regionId: null, url: target },
    });
  });

  it.each([
    "https://docs.aliyun.com/guide",
    "https://team.internal.aliyun.com/runbook",
  ])("allows any HTTPS aliyun.com subdomain by default: %s", (target) => {
    expect(parseExternalOpenUrl(externalUrl(target))).toEqual({
      ok: true,
      target: { product: "aliyun", regionId: null, url: target },
    });
  });

  it.each([
    "https://aliyun.com/",
    "https://aliyun.com.evil.example/",
  ])("does not let the aliyun.com wildcard match an apex or lookalike: %s", (target) => {
    expect(parseExternalOpenUrl(externalUrl(target))).toMatchObject({ ok: false });
  });

  it.each([
    "http://codeup.aliyun.com/org/repository/1",
    "javascript:alert(1)",
    "file:///tmp/secret",
  ])("rejects a non-HTTPS target: %s", (target) => {
    expect(parseExternalOpenUrl(externalUrl(target))).toEqual({
      ok: false,
      reason: "外部跳转只允许 HTTPS 目标",
    });
  });

  it("rejects credentials, custom ports, lookalike hosts, and missing regional context", () => {
    expect(parseExternalOpenUrl(externalUrl("https://user@codeup.aliyun.com/repo"))).toMatchObject({ ok: false });
    expect(parseExternalOpenUrl(externalUrl("https://codeup.aliyun.com:8443/repo"))).toMatchObject({ ok: false });
    expect(parseExternalOpenUrl(externalUrl("https://codeup.aliyun.com.evil.example/repo"))).toEqual({
      ok: false,
      reason: "目标主机不在白名单：codeup.aliyun.com.evil.example",
    });
    expect(parseExternalOpenUrl(externalUrl("https://signin.aliyun.com.evil.example/login"))).toEqual({
      ok: false,
      reason: "目标主机不在白名单：signin.aliyun.com.evil.example",
    });
    expect(parseExternalOpenUrl(externalUrl("https://cs.console.aliyun.com/"))).toEqual({
      ok: false,
      reason: "该控制台链接缺少可识别的地域",
    });
  });

  it("rejects malformed entry points and extra parameters", () => {
    expect(parseExternalOpenUrl("clouddock://settings?url=https%3A%2F%2Fcodeup.aliyun.com")).toMatchObject({ ok: false });
    expect(parseExternalOpenUrl("clouddock://open?url=https%3A%2F%2Fcodeup.aliyun.com&other=1")).toEqual({
      ok: false,
      reason: "CloudDock 跳转只接受一个 url 参数",
    });
    expect(parseExternalOpenUrl("https://codeup.aliyun.com/")).toEqual({
      ok: false,
      reason: "不支持的 CloudDock 跳转协议",
    });
  });

  it("parses exact and subdomain configuration without letting a wildcard match its apex", () => {
    const rules = parseExternalOpenHostRules(
      "docs.example.com, *.tools.example.com, bad host, docs.example.com",
    );
    expect(rules).toEqual([
      { kind: "exact", hostname: "docs.example.com" },
      { kind: "subdomains", hostname: "tools.example.com" },
    ]);
    expect(parseExternalOpenUrl(externalUrl("https://docs.example.com/runbook"), rules)).toMatchObject({
      ok: true,
      target: { product: "aliyun" },
    });
    expect(parseExternalOpenUrl(externalUrl("https://team.tools.example.com/runbook"), rules)).toMatchObject({ ok: true });
    expect(parseExternalOpenUrl(externalUrl("https://tools.example.com/runbook"), rules)).toMatchObject({ ok: false });
    expect(parseExternalOpenUrl(externalUrl("https://eviltools.example.com/runbook"), rules)).toMatchObject({ ok: false });
  });
});
