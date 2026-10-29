import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  flushStorageData: vi.fn(),
  flushStore: vi.fn(async () => undefined),
  sessionListeners: new Map<string, (...args: any[]) => void>(),
  setPermissionCheckHandler: vi.fn(),
  setPermissionRequestHandler: vi.fn(),
  setDevicePermissionHandler: vi.fn(),
  setDisplayMediaRequestHandler: vi.fn(),
  setSpellCheckerEnabled: vi.fn(),
}));

vi.mock("electron", () => ({
  session: {
    fromPartition: vi.fn(() => ({
      flushStorageData: electronMocks.flushStorageData,
      cookies: { flushStore: electronMocks.flushStore },
      setPermissionCheckHandler: electronMocks.setPermissionCheckHandler,
      setPermissionRequestHandler: electronMocks.setPermissionRequestHandler,
      setDevicePermissionHandler: electronMocks.setDevicePermissionHandler,
      setDisplayMediaRequestHandler: electronMocks.setDisplayMediaRequestHandler,
      setSpellCheckerEnabled: electronMocks.setSpellCheckerEnabled,
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        electronMocks.sessionListeners.set(event, listener);
      }),
    })),
  },
}));

import { ConsoleSession } from "../../src/main/modules/console-session/console-session";

describe("ConsoleSession.flushCookies", () => {
  beforeEach(() => {
    electronMocks.flushStorageData.mockReset();
    electronMocks.flushStore.mockReset();
    electronMocks.sessionListeners.clear();
  });

  it("flushes DOM Storage before the cookie store", async () => {
    const calls: string[] = [];
    electronMocks.flushStorageData.mockImplementation(() => calls.push("dom-storage"));
    electronMocks.flushStore.mockImplementation(async () => {
      calls.push("cookies");
    });

    await new ConsoleSession().flushCookies();

    expect(calls).toEqual(["dom-storage", "cookies"]);
  });

  it("reports useful download progress and final completion", () => {
    const statuses: unknown[] = [];
    const session = new ConsoleSession({ onDownloadStatus: (status) => statuses.push(status) });
    session.installPolicies();
    const willDownload = electronMocks.sessionListeners.get("will-download");
    expect(willDownload).toBeTypeOf("function");

    let receivedBytes = 0;
    const itemListeners = new Map<string, (...args: any[]) => void>();
    const item = {
      setSaveDialogOptions: vi.fn(),
      getFilename: () => "export.csv",
      getTotalBytes: () => 1_000,
      getReceivedBytes: () => receivedBytes,
      isPaused: () => false,
      on: (event: string, listener: (...args: any[]) => void) => itemListeners.set(event, listener),
      once: (event: string, listener: (...args: any[]) => void) => itemListeners.set(event, listener),
    };

    willDownload?.(
      { preventDefault: vi.fn() },
      item,
      { getURL: () => "https://dms.aliyun.com/export" },
    );
    receivedBytes = 470;
    itemListeners.get("updated")?.({}, "progressing");
    receivedBytes = 510;
    itemListeners.get("updated")?.({}, "progressing");
    itemListeners.get("done")?.({}, "completed");

    expect(statuses).toEqual([
      { type: "started", fileName: "export.csv" },
      { type: "progress", fileName: "export.csv", percent: 40 },
      { type: "progress", fileName: "export.csv", percent: 50 },
      { type: "completed", fileName: "export.csv" },
    ]);
  });
});
