import { describe, expect, it } from "vitest";
import type { WorkspaceTab } from "../../src/shared/model";
import {
  getProductContextLabel,
  getProductRegionIds,
  getTabDisplayTitle,
  GLOBAL_PRODUCT_ENTRIES,
  GLOBAL_PRODUCTS,
  isRegionalProduct,
  productLabel,
  PRODUCTS,
  REGIONAL_PRODUCTS,
} from "../../src/shared/workspace-display";

function tab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab",
    product: "ack",
    regionId: "cn-beijing",
    url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing",
    title: "集群列表",
    createdAt: 1,
    lastActiveAt: 1,
    pinned: false,
    taskStatus: null,
    loadState: "ready",
    canGoBack: false,
    canGoForward: false,
    ...overrides,
  };
}

describe("workspace display helpers", () => {
  it("defines MSE as regional and DMS, Codeup, and SLS as global", () => {
    expect(PRODUCTS).toEqual(["ack", "kafka", "mse", "dms", "codeup", "sls"]);
    expect(REGIONAL_PRODUCTS).toEqual(["ack", "kafka", "mse"]);
    expect(GLOBAL_PRODUCTS).toEqual(["dms", "codeup", "sls"]);
    expect(isRegionalProduct("ack")).toBe(true);
    expect(isRegionalProduct("mse")).toBe(true);
    expect(isRegionalProduct("codeup")).toBe(false);
    expect(isRegionalProduct("sls")).toBe(false);
    expect(isRegionalProduct("aliyun")).toBe(false);
    expect(productLabel("dms")).toBe("DMS");
    expect(productLabel("codeup")).toBe("Codeup");
    expect(productLabel("sls")).toBe("SLS");
    expect(productLabel("mse")).toBe("MSE");
    expect(productLabel("aliyun")).toBe("阿里云");
    expect(
      getProductRegionIds("mse", ["cn-hangzhou", "cn-shanghai", "cn-beijing"]),
    ).toEqual(["cn-shanghai", "cn-beijing"]);
    expect(getProductRegionIds("ack", ["cn-hangzhou", "cn-shanghai"])).toEqual([
      "cn-hangzhou",
      "cn-shanghai",
    ]);
    expect(GLOBAL_PRODUCT_ENTRIES).toEqual([
      { product: "dms", label: "数据管理" },
      { product: "codeup", label: "代码管理" },
      { product: "sls", label: "日志服务" },
    ]);
  });

  it("keeps region suffixes for regional products", () => {
    expect(getProductContextLabel("ack", "cn-beijing")).toBe("ACK · 北京");
    expect(getTabDisplayTitle(tab())).toBe("集群列表 · 北京");
  });

  it("does not render a fake region suffix for DMS", () => {
    const dms = tab({
      product: "dms",
      regionId: null,
      title: "DMS - Data Management Service",
      url: "https://dms.aliyun.com/",
    });
    expect(getProductContextLabel("dms", null)).toBe("DMS");
    expect(getTabDisplayTitle(dms)).toBe("DMS - Data Management Service");

    const codeup = tab({
      product: "codeup",
      regionId: null,
      title: "Codeup",
      url: "https://codeup.aliyun.com/",
    });
    expect(getProductContextLabel("codeup", null)).toBe("Codeup");
    expect(getTabDisplayTitle(codeup)).toBe("Codeup");

    const sls = tab({
      product: "sls",
      regionId: null,
      title: "示例应用日志",
      url: "https://sls.console.aliyun.com/lognext/profile",
    });
    expect(getProductContextLabel("sls", null)).toBe("SLS");
    expect(getTabDisplayTitle(sls)).toBe("示例应用日志");
  });
});
