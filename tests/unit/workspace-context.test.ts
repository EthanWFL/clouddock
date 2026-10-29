import { describe, expect, it } from "vitest";
import { formatWorkspaceContext } from "../../src/main/modules/workspace-context/workspace-context";
import { createDefaultSnapshot, type WorkspaceTab } from "../../src/shared/model";

function tab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "ack-1",
    product: "ack",
    regionId: "cn-beijing",
    url: "https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing&spm=tracking",
    title: "生产集群",
    createdAt: 1,
    lastActiveAt: 1,
    pinned: false,
    taskStatus: "doing",
    loadState: "ready",
    canGoBack: false,
    canGoForward: false,
    ...overrides,
  };
}

describe("formatWorkspaceContext", () => {
  it("copies the safe current URL and only the persisted filtered task queue", () => {
    const active = tab();
    const kafka = tab({
      id: "kafka-1",
      product: "kafka",
      regionId: "cn-shanghai",
      url: "https://kafka.console.aliyun.com/region/cn-shanghai/instances",
      title: "Kafka 实例",
      taskStatus: "todo",
    });
    const snapshot = {
      ...createDefaultSnapshot(),
      onboardingComplete: true,
      tabs: [active, kafka],
      activeTabId: active.id,
      productFilter: "ack" as const,
      taskFilter: "doing" as const,
    };

    const result = formatWorkspaceContext(snapshot);

    expect(result).toContain("当前页面：生产集群 · 北京");
    expect(result).toContain("链接：https://cs.console.aliyun.com/#/k8s/cluster/list?region=cn-beijing");
    expect(result).toContain("筛选：ACK / 处理中");
    expect(result).toContain("任务队列（1）");
    expect(result).not.toContain("Kafka 实例");
  });

  it("rejects authentication pages", () => {
    const active = tab({
      url: "https://signin.aliyun.com/login.htm",
      isAuthenticating: true,
      externalHostname: "signin.aliyun.com",
    });
    const snapshot = {
      ...createDefaultSnapshot(),
      tabs: [active],
      activeTabId: active.id,
    };

    expect(() => formatWorkspaceContext(snapshot)).toThrow("登录或外部页面");
  });

  it("matches the visible queue semantics for all states and the active tab", () => {
    const active = tab({ taskStatus: null });
    const unmarked = tab({ id: "ack-2", title: "未标记页面", taskStatus: null });
    const kafka = tab({
      id: "kafka-1",
      product: "kafka",
      regionId: "cn-shanghai",
      url: "https://kafka.console.aliyun.com/region/cn-shanghai/instances",
      title: "筛选外活动页",
    });
    const snapshot = {
      ...createDefaultSnapshot(),
      tabs: [active, unmarked, kafka],
      activeTabId: kafka.id,
      productFilter: "ack" as const,
      taskFilter: "all" as const,
    };

    const result = formatWorkspaceContext(snapshot);

    expect(result).toContain("任务队列（3）");
    expect(result).toContain("未标记页面");
    expect(result).toContain("筛选外活动页");
  });
});
