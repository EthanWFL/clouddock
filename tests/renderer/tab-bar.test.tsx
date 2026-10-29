import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createDefaultSnapshot, type WorkspaceTab } from "../../src/shared/model";
import { useRendererStore } from "../../src/renderer/src/store";
import { TabBar } from "../../src/renderer/src/TabBar";
import { ProductIcon } from "../../src/renderer/src/ProductIcon";

vi.mock("../../src/renderer/src/ProductIcon", async (original) => {
  const module = await original<typeof import("../../src/renderer/src/ProductIcon")>();
  return { ...module, ProductIcon: vi.fn(module.ProductIcon) };
});

it("renders only the changed tab when a background page reports progress", () => {
  const first: WorkspaceTab = {
    id: "first", product: "codeup", regionId: null, url: "https://codeup.aliyun.com/", title: "Codeup",
    createdAt: 1, lastActiveAt: 1, pinned: false, taskStatus: null, loadState: "ready", canGoBack: false, canGoForward: false,
  };
  const second = { ...first, id: "second", product: "sls" as const, url: "https://sls.console.aliyun.com/", title: "SLS" };
  const snapshot = { ...createDefaultSnapshot(), tabs: [first, second], activeTabId: first.id };
  useRendererStore.setState({ snapshot });
  render(<TabBar />);
  vi.mocked(ProductIcon).mockClear();
  const next = structuredClone(snapshot);
  next.tabs[1].loadState = "loading";
  act(() => useRendererStore.getState().setSnapshot(next));
  expect(ProductIcon).toHaveBeenCalledOnce();
  expect(vi.mocked(ProductIcon).mock.calls[0][0].product).toBe("sls");
  expect(screen.getByRole("tab", { name: "SLS" }).querySelector(".tab-status")).not.toBeNull();
  expect(screen.getByRole("tab", { name: "Codeup" })).toHaveAttribute("aria-selected", "true");
});
