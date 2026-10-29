import { describe, expect, it, vi } from "vitest";
import { createElement, Profiler } from "react";
import { act, render } from "@testing-library/react";
import { createDefaultSnapshot, type WorkspaceTab } from "../../src/shared/model";
import { useRendererStore } from "../../src/renderer/src/store";
import { Sidebar } from "../../src/renderer/src/Sidebar";

describe("renderer snapshot reconciliation", () => {
  it("retains unrelated references when only a background tab changes", () => {
    const tab: WorkspaceTab = {
      id: "active", product: "codeup", regionId: null, url: "https://codeup.aliyun.com/", title: "Codeup",
      createdAt: 1, lastActiveAt: 1, pinned: false, taskStatus: null, loadState: "ready", canGoBack: false, canGoForward: false,
    };
    const snapshot = { ...createDefaultSnapshot(), tabs: [tab, { ...tab, id: "background" }], activeTabId: tab.id };
    useRendererStore.setState({ snapshot });
    const onRender = vi.fn();
    render(createElement(Profiler, { id: "sidebar", onRender }, createElement(Sidebar)));
    onRender.mockClear();
    const next = structuredClone(snapshot);
    next.tabs[1].loadState = "loading";
    act(() => useRendererStore.getState().setSnapshot(next));
    const actual = useRendererStore.getState().snapshot!;
    expect(actual.tabs[0]).toBe(snapshot.tabs[0]);
    expect(actual.tabs[1]).not.toBe(snapshot.tabs[1]);
    expect(actual.favorites).toBe(snapshot.favorites);
    expect(actual.productRegionIds).toBe(snapshot.productRegionIds);
    expect(actual.windowBounds).toBe(snapshot.windowBounds);
    expect(onRender).not.toHaveBeenCalled();
    act(() => useRendererStore.getState().setSnapshot(structuredClone(actual)));
    expect(useRendererStore.getState().snapshot).toBe(actual);
  });
});
