import { describe, expect, it } from "vitest";

import {
  buildConsoleEntryUrl,
  extractConsoleUrls,
  normalizeConsoleUrl,
  parseConsoleTarget,
  parseObservedConsoleTarget,
  parseProduct,
  parseRegionId,
} from "../../src/shared/console-url";

const SLS_TEST_QUERY_URL = "https://sls.console.aliyun.com/lognext/project/example-project/logsearch/sample-app?slsRegion=cn-beijing";

describe("buildConsoleEntryUrl", () => {
  it.each([
    [
      "ack" as const,
      "cn-beijing",
      "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
    ],
    [
      "kafka" as const,
      "cn-shanghai",
      "https://kafka.console.aliyun.com/region/cn-shanghai/instances",
    ],
    [
      "mse" as const,
      "cn-beijing",
      "https://mse.console.aliyun.com/#/InstanceList?region=cn-beijing",
    ],
    ["dms" as const, null, "https://dms.aliyun.com/"],
    ["codeup" as const, null, "https://codeup.aliyun.com/"],
    ["sls" as const, null, "https://sls.console.aliyun.com/lognext/profile"],
  ] as const)("builds the %s product entry", (product, regionId, expected) => {
    expect(buildConsoleEntryUrl(product, regionId)).toBe(expected);
  });

  it("encodes a region before placing it in a URL", () => {
    expect(buildConsoleEntryUrl("ack", "cn/test value")).toContain(
      "region=cn%2Ftest%20value",
    );
    expect(buildConsoleEntryUrl("kafka", "cn/test value")).toContain(
      "/region/cn%2Ftest%20value/instances",
    );
    expect(buildConsoleEntryUrl("mse", "cn/test value")).toContain(
      "region=cn%2Ftest%20value",
    );
  });
});

describe("parseProduct", () => {
  it.each([
    ["https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing", "ack"],
    ["https://kafka.console.aliyun.com/region/cn-beijing/instances", "kafka"],
    ["https://mse.console.aliyun.com/#/InstanceList?region=cn-beijing", "mse"],
    ["https://dms.aliyun.com/", "dms"],
    ["https://dmsnext.console.aliyun.com/workbench", "dms"],
    ["https://codeup.aliyun.com/", "codeup"],
    ["https://flow.aliyun.com/pipelines/123", "codeup"],
    ["https://sls.console.aliyun.com/lognext/profile", "sls"],
    ["https://ecs.console.aliyun.com/ecs/home", "aliyun"],
    ["https://rds.console.aliyun.com/", "aliyun"],
    ["https://rdsnext.console.aliyun.com/", "aliyun"],
    ["https://oss.console.aliyun.com/", "aliyun"],
    ["https://cloudmonitor.console.aliyun.com/", "aliyun"],
    ["https://home.console.aliyun.com/", "aliyun"],
    ["https://CS.CONSOLE.ALIYUN.COM/#/k8s/cluster/list", "ack"],
  ])("recognizes an exact console host for %s", (url, expected) => {
    expect(parseProduct(url)).toBe(expected);
  });

  it.each([
    "https://help.aliyun.com/",
    "https://cs.console.aliyun.com.evil.example/",
    "https://sub.cs.console.aliyun.com/",
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
    "/relative/path",
    "not a url",
    "",
  ])("rejects a non-console or malformed URL: %s", (url) => {
    expect(parseProduct(url)).toBeNull();
  });
});

describe("parseRegionId", () => {
  it("reads an ordinary query parameter", () => {
    expect(
      parseRegionId(
        "https://kafka.console.aliyun.com/region/cn-shanghai/instances?region=cn-beijing",
      ),
    ).toBe("cn-beijing");
  });

  it("reads the region from an ACK hash route", () => {
    expect(
      parseRegionId(
        "https://cs.console.aliyun.com/#/k8s/cluster/list?foo=bar&region=cn-hangzhou",
      ),
    ).toBe("cn-hangzhou");
  });

  it("reads the region from an MSE hash route", () => {
    expect(
      parseRegionId(
        "https://mse.console.aliyun.com/#/InstanceList?foo=bar&region=cn-shanghai",
      ),
    ).toBe("cn-shanghai");
  });

  it("reads and decodes the Kafka path region", () => {
    expect(
      parseRegionId(
        "https://kafka.console.aliyun.com/region/cn%2Dshanghai/consumer-groups/group-a",
      ),
    ).toBe("cn-shanghai");
  });

  it("does not infer a region for global products even when a query parameter is present", () => {
    expect(parseRegionId("https://dms.aliyun.com/?region=cn-beijing")).toBeNull();
    expect(parseRegionId("https://codeup.aliyun.com/?region=cn-beijing")).toBeNull();
    expect(parseRegionId("https://flow.aliyun.com/pipelines/123?region=cn-beijing")).toBeNull();
    expect(parseRegionId(SLS_TEST_QUERY_URL)).toBeNull();
  });

  it.each([
    "https://cs.console.aliyun.com/#/k8s/cluster/list",
    "https://kafka.console.aliyun.com/instances",
    "https://mse.console.aliyun.com/#/InstanceList",
    "https://help.aliyun.com/?product=ack",
    "not a url",
    "",
  ])("returns null when the region is unavailable: %s", (url) => {
    expect(parseRegionId(url)).toBeNull();
  });
});

describe("normalizeConsoleUrl", () => {
  it("removes tracking parameters from the outer query and sorts the rest", () => {
    expect(
      normalizeConsoleUrl(
        "https://kafka.console.aliyun.com/region/cn-beijing/instances/?spm=trace&z=last&source=nav&a=first",
      ),
    ).toBe(
      "https://kafka.console.aliyun.com/region/cn-beijing/instances?a=first&z=last",
    );
  });

  it("removes case-insensitive tracking parameters from an ACK hash route", () => {
    expect(
      normalizeConsoleUrl(
        "https://cs.console.aliyun.com/?FROM=home#/k8s/cluster/list?spm=trace&region=cn-beijing&SCM=campaign",
      ),
    ).toBe(
      "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
    );
  });

  it("keeps resource identifiers and sorts duplicate query values deterministically", () => {
    expect(
      normalizeConsoleUrl(
        "https://kafka.console.aliyun.com/region/cn-beijing/topics/topic-a?consumer=group-b&tag=z&tag=a",
      ),
    ).toBe(
      "https://kafka.console.aliyun.com/region/cn-beijing/topics/topic-a?consumer=group-b&tag=a&tag=z",
    );
  });

  it("removes a trailing path slash but preserves the root slash", () => {
    expect(
      normalizeConsoleUrl(
        "https://kafka.console.aliyun.com/region/cn-beijing/instances/",
      ),
    ).toBe("https://kafka.console.aliyun.com/region/cn-beijing/instances");
    expect(normalizeConsoleUrl("https://cs.console.aliyun.com/")).toBe(
      "https://cs.console.aliyun.com/",
    );
  });

  it("preserves a hash route when every hash query parameter is tracking", () => {
    expect(
      normalizeConsoleUrl(
        "https://cs.console.aliyun.com/#/k8s/cluster/list?spm=trace&from=home",
      ),
    ).toBe("https://cs.console.aliyun.com/#/k8s/cluster/list");
  });

  it("throws for malformed input instead of returning an unsafe fallback", () => {
    expect(() => normalizeConsoleUrl("not a url")).toThrow();
  });

  it("normalizes equivalent DMS entry URLs without inventing a region", () => {
    expect(normalizeConsoleUrl("https://dms.aliyun.com/?spm=first&source=nav")).toBe(
      "https://dms.aliyun.com/",
    );
  });

  it("normalizes equivalent Codeup entry URLs without inventing a region", () => {
    expect(normalizeConsoleUrl("https://codeup.aliyun.com/?from=home&source=nav")).toBe(
      "https://codeup.aliyun.com/",
    );
  });

  it("preserves the SLS query region while keeping it outside workspace region state", () => {
    expect(normalizeConsoleUrl(`${SLS_TEST_QUERY_URL}&source=nav`)).toBe(
      SLS_TEST_QUERY_URL,
    );
    expect(parseRegionId(SLS_TEST_QUERY_URL)).toBeNull();
  });
});

describe("parseConsoleTarget", () => {
  it.each([
    [
      "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
      { product: "ack", regionId: "cn-beijing" },
    ],
    [
      "https://kafka.console.aliyun.com/region/cn-shanghai/instances",
      { product: "kafka", regionId: "cn-shanghai" },
    ],
    [
      "https://mse.console.aliyun.com/#/InstanceList?region=cn-beijing",
      { product: "mse", regionId: "cn-beijing" },
    ],
    ["https://dms.aliyun.com/", { product: "dms", regionId: null }],
    [
      "https://dmsnext.console.aliyun.com/workbench?region=cn-beijing",
      { product: "dms", regionId: null },
    ],
    ["https://codeup.aliyun.com/", { product: "codeup", regionId: null }],
    ["https://codeup.aliyun.com/org/project?region=cn-beijing", { product: "codeup", regionId: null }],
    ["https://flow.aliyun.com/pipelines/123?region=cn-beijing", { product: "codeup", regionId: null }],
    [SLS_TEST_QUERY_URL, { product: "sls", regionId: null }],
  ] as const)("returns a complete target for %s", (url, expected) => {
    expect(parseConsoleTarget(url)).toEqual({ ...expected, url });
  });

  it.each([
    "https://cs.console.aliyun.com/#/k8s/cluster/list",
    "https://kafka.console.aliyun.com/instances?region=",
    "https://mse.console.aliyun.com/#/InstanceList",
    "https://help.aliyun.com/?region=cn-beijing",
    "not a url",
  ])("requires a recognized product and a non-empty region: %s", (url) => {
    expect(parseConsoleTarget(url)).toBeNull();
  });
});

describe("parseObservedConsoleTarget", () => {
  it("recognizes the E2E console route only when test navigation is enabled", () => {
    const url = "http://127.0.0.1:4173/kafka/details?region=cn-shanghai";
    expect(parseObservedConsoleTarget(url)).toBeNull();
    expect(parseObservedConsoleTarget(url, true)).toEqual({
      product: "kafka",
      regionId: "cn-shanghai",
      url,
    });
  });

  it("recognizes an E2E MSE route with a region", () => {
    const url = "http://127.0.0.1:4173/mse/details?region=cn-beijing";
    expect(parseObservedConsoleTarget(url, true)).toEqual({
      product: "mse",
      regionId: "cn-beijing",
      url,
    });
  });

  it.each([
    ["dms" as const, "http://127.0.0.1:4173/dms/details"],
    ["codeup" as const, "http://127.0.0.1:4173/codeup/details"],
    ["sls" as const, "http://127.0.0.1:4173/sls/details"],
  ])("recognizes an E2E %s route without requiring a region", (product, url) => {
    expect(parseObservedConsoleTarget(url)).toBeNull();
    expect(parseObservedConsoleTarget(url, true)).toEqual({
      product,
      regionId: null,
      url,
    });
  });
});

describe("extractConsoleUrls", () => {
  it("extracts supported targets, trims punctuation, upgrades HTTP, and deduplicates", () => {
    expect(extractConsoleUrls(`
      ECS：http://ecs.console.aliyun.com/#/instances?spm=chat，
      重复：https://ecs.console.aliyun.com/#/instances?from=copy。
      RDS (https://rdsnext.console.aliyun.com/workbench).
      未接入：https://example.com/
    `)).toEqual([
      "https://ecs.console.aliyun.com/#/instances?spm=chat",
      "https://rdsnext.console.aliyun.com/workbench",
    ]);
  });

  it("uses normalization only for deduplication and preserves the first real URL", () => {
    expect(extractConsoleUrls(`
      https://flow.aliyun.com/pipelines/123?source=chat&branch=main
      https://flow.aliyun.com/pipelines/123?branch=main&spm=duplicate
    `)).toEqual([
      "https://flow.aliyun.com/pipelines/123?source=chat&branch=main",
    ]);
  });

  it("returns at most ten URLs and honors a smaller limit", () => {
    const text = Array.from(
      { length: 12 },
      (_, index) => `https://oss.console.aliyun.com/bucket/${index}`,
    ).join("\n");

    expect(extractConsoleUrls(text)).toHaveLength(10);
    expect(extractConsoleUrls(text, 2)).toEqual([
      "https://oss.console.aliyun.com/bucket/0",
      "https://oss.console.aliyun.com/bucket/1",
    ]);
  });
});
