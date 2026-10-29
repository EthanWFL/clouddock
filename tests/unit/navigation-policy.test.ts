import { describe, expect, it } from "vitest";

import {
  decideNavigation,
  isAllowedConsoleHost,
  isTrustedConsoleDownloadSource,
} from "../../src/shared/navigation-policy";

describe("decideNavigation", () => {
  describe("input and protocol validation", () => {
    it.each(["", "not a url", "/relative/path"])(
      "blocks malformed input: %s",
      (url) => {
        expect(decideNavigation(url, "current")).toEqual({
          kind: "block",
          reason: "链接格式无效",
        });
      },
    );

    it.each([
      "file:///tmp/secret",
      "javascript:alert(1)",
      "data:text/html,hello",
      "opsdock://open/ack",
    ])("blocks a non-HTTPS URL: %s", (url) => {
      expect(decideNavigation(url, "current")).toEqual({
        kind: "block",
        reason: "只允许 HTTPS 页面链接",
      });
    });

    it.each([
      "http://account.aliyun.com/login/login.htm?oauth_callback=https%3A%2F%2Fsls.console.aliyun.com%2Flognext%2Fprofile",
      "http://account-devops.aliyun.com/login?next_url=http%3A%2F%2Fcodeup.aliyun.com%2F",
      "http://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
      "http://mse.console.aliyun.com/#/InstanceList?region=cn-shanghai",
      "http://sls.console.aliyun.com/lognext/profile",
      "http://flow.aliyun.com/pipelines/123",
      "http://ecs.console.aliyun.com/ecs/home",
    ])("upgrades an exact trusted HTTP redirect without loading it insecurely: %s", (url) => {
      const expected = new URL(url);
      expected.protocol = "https:";
      expect(decideNavigation(url, "current")).toEqual({
        kind: "load-secure-url",
        url: expected.toString(),
      });
    });
  });

  describe("console pages", () => {
    it.each([
      "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
      "https://kafka.console.aliyun.com/region/cn-shanghai/instances",
      "https://mse.console.aliyun.com/#/InstanceList?region=cn-beijing",
      "https://dms.aliyun.com/",
      "https://dmsnext.console.aliyun.com/workbench",
      "https://codeup.aliyun.com/",
      "https://flow.aliyun.com/pipelines/123",
      "https://sls.console.aliyun.com/lognext/profile",
      "https://ecs.console.aliyun.com/ecs/home",
      "https://rds.console.aliyun.com/",
      "https://rdsnext.console.aliyun.com/",
      "https://oss.console.aliyun.com/",
      "https://cloudmonitor.console.aliyun.com/",
      "https://home.console.aliyun.com/",
    ])("allows an exact console host in the current tab: %s", (url) => {
      expect(decideNavigation(url, "current")).toEqual({
        kind: "allow-current",
      });
    });

    it.each([
      [
        "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
        "ack",
        "cn-beijing",
      ],
      [
        "https://kafka.console.aliyun.com/region/cn-shanghai/instances",
        "kafka",
        "cn-shanghai",
      ],
      [
        "https://mse.console.aliyun.com/#/InstanceList?region=cn-beijing",
        "mse",
        "cn-beijing",
      ],
      ["https://dms.aliyun.com/", "dms", null],
      ["https://dmsnext.console.aliyun.com/workbench", "dms", null],
      ["https://codeup.aliyun.com/", "codeup", null],
      ["https://flow.aliyun.com/pipelines/123", "codeup", null],
      ["https://sls.console.aliyun.com/lognext/profile", "sls", null],
      ["https://ecs.console.aliyun.com/ecs/home", "aliyun", null],
      ["https://rds.console.aliyun.com/", "aliyun", null],
      ["https://rdsnext.console.aliyun.com/", "aliyun", null],
      ["https://oss.console.aliyun.com/", "aliyun", null],
      ["https://cloudmonitor.console.aliyun.com/", "aliyun", null],
      ["https://home.console.aliyun.com/", "aliyun", null],
    ] as const)(
      "opens a console popup as a CloudDock tab: %s",
      (url, product, regionId) => {
        expect(decideNavigation(url, "popup")).toEqual({
          kind: "open-console-tab",
          target: { product, regionId, url },
        });
      },
    );

    it.each([
      "https://cs.console.aliyun.com/#/k8s/cluster/list",
      "https://kafka.console.aliyun.com/instances",
      "https://mse.console.aliyun.com/#/InstanceList",
    ])("keeps an unparsed console popup in the current view: %s", (url) => {
      expect(decideNavigation(url, "popup")).toEqual({ kind: "allow-current" });
    });

    it("does not require region parsing for current-tab SPA navigation", () => {
      expect(
        decideNavigation("https://cs.console.aliyun.com/", "current"),
      ).toEqual({ kind: "allow-current" });
    });
  });

  describe("authentication pages", () => {
    it.each([
      "account.aliyun.com",
      "signin.aliyun.com",
      "login.aliyun.com",
      "passport.aliyun.com",
      "account-devops.aliyun.com",
    ])("allows the exact authentication host %s", (hostname) => {
      expect(
        decideNavigation(`https://${hostname}/login?redirect=console`, "current"),
      ).toEqual({ kind: "allow-current" });
      expect(
        decideNavigation(`https://${hostname}/login?redirect=console`, "popup"),
      ).toEqual({ kind: "allow-current" });
    });

  });

  describe("other HTTPS hosts", () => {
    it.each([
      "https://example.com/",
      "https://cs.console.aliyun.com.evil.example/",
      "https://sub.kafka.console.aliyun.com/",
      "https://sub.dms.aliyun.com/",
      "https://dms.aliyun.com.evil.example/",
      "https://sub.codeup.aliyun.com/",
      "https://codeup.aliyun.com.evil.example/",
      "https://sub.flow.aliyun.com/",
      "https://flow.aliyun.com.evil.example/",
      "https://sub.sls.console.aliyun.com/",
      "https://sls.console.aliyun.com.evil.example/",
      "https://sub.mse.console.aliyun.com/",
      "https://mse.console.aliyun.com.evil.example/",
      "https://help.aliyun.com/product/ack",
      "https://www.aliyun.com/product/ack",
      "https://help.aliyun.com.evil.example/",
    ])("allows a host without a domain allowlist: %s", (url) => {
      expect(decideNavigation(url, "current")).toEqual({ kind: "allow-current" });
      expect(decideNavigation(url, "popup")).toEqual({ kind: "allow-current" });
    });
  });

  describe("test server exception", () => {
    it.each(["localhost", "127.0.0.1"])(
      "allows an HTTP current navigation to %s only when explicitly enabled",
      (hostname) => {
        const url = `http://${hostname}:4173/console?region=cn-test`;
        expect(decideNavigation(url, "current", { allowTestServer: true })).toEqual({
          kind: "allow-current",
        });
        expect(decideNavigation(url, "current")).toEqual({
          kind: "block",
          reason: "只允许 HTTPS 页面链接",
        });
      },
    );

    it("maps a test-server popup to a deterministic console target", () => {
      const url = "http://localhost:4173/popup";
      expect(decideNavigation(url, "popup", { allowTestServer: true })).toEqual({
        kind: "open-console-tab",
        target: { product: "ack", regionId: "cn-beijing", url },
      });
    });

    it("does not extend the exception to other loopback-looking hosts", () => {
      expect(
        decideNavigation("http://0.0.0.0:4173/", "current", {
          allowTestServer: true,
        }),
      ).toEqual({
        kind: "block",
        reason: "只允许 HTTPS 页面链接",
      });
    });

    it("allows HTTPS localhost because production navigation has no domain allowlist", () => {
      expect(
        decideNavigation("https://localhost:4173/", "current", {
          allowTestServer: true,
        }),
      ).toEqual({ kind: "allow-current" });
    });
  });
});

describe("isAllowedConsoleHost", () => {
  it.each([
    "cs.console.aliyun.com",
    "kafka.console.aliyun.com",
    "dms.aliyun.com",
    "dmsnext.console.aliyun.com",
    "codeup.aliyun.com",
    "flow.aliyun.com",
    "sls.console.aliyun.com",
    "mse.console.aliyun.com",
    "ecs.console.aliyun.com",
    "rds.console.aliyun.com",
    "rdsnext.console.aliyun.com",
    "oss.console.aliyun.com",
    "cloudmonitor.console.aliyun.com",
    "home.console.aliyun.com",
  ])(
    "accepts %s",
    (hostname) => {
      expect(isAllowedConsoleHost(hostname)).toBe(true);
    },
  );

  it.each([
    "help.aliyun.com",
    "login.aliyun.com",
    "sub.cs.console.aliyun.com",
    "cs.console.aliyun.com.evil.example",
    "CS.CONSOLE.ALIYUN.COM",
    "",
  ])("rejects a non-exact console hostname: %s", (hostname) => {
    expect(isAllowedConsoleHost(hostname)).toBe(false);
  });
});

describe("isTrustedConsoleDownloadSource", () => {
  it.each([
    "https://cs.console.aliyun.com/",
    "https://kafka.console.aliyun.com/instances",
    "https://mse.console.aliyun.com/#/InstanceList",
    "https://dms.aliyun.com/",
    "https://dmsnext.console.aliyun.com/workbench",
    "https://codeup.aliyun.com/",
    "https://flow.aliyun.com/pipelines/123",
    "https://sls.console.aliyun.com/lognext/profile",
    "https://ecs.console.aliyun.com/ecs/home",
  ])("accepts an exact HTTPS console source without requiring a region: %s", (url) => {
    expect(isTrustedConsoleDownloadSource(url)).toBe(true);
  });

  it.each([
    "https://example.com/download",
    "https://login.aliyun.com/",
    "https://cs.console.aliyun.com.evil.example/",
    "http://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
    "file:///tmp/export.csv",
    "not a url",
  ])("rejects a non-console or insecure source: %s", (url) => {
    expect(isTrustedConsoleDownloadSource(url)).toBe(false);
  });

  it("accepts only recognized fake-console paths when the E2E exception is enabled", () => {
    expect(isTrustedConsoleDownloadSource(
      "http://127.0.0.1:4173/dms/export",
      { allowTestServer: true },
    )).toBe(true);
    expect(isTrustedConsoleDownloadSource(
      "http://127.0.0.1:4173/permissions",
      { allowTestServer: true },
    )).toBe(false);
  });
});
