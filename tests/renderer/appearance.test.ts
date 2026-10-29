import { describe, expect, it, vi } from "vitest";
import type { AppAppearance } from "../../src/shared/api";
import { synchronizeAppearance } from "../../src/renderer/src/appearance";

function deferredAppearance() {
  let resolve!: (appearance: AppAppearance) => void;
  const promise = new Promise<AppAppearance>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("synchronizeAppearance", () => {
  it("applies the initial appearance when no newer event arrives", async () => {
    const initial = deferredAppearance();
    const apply = vi.fn();
    const unsubscribe = vi.fn();
    const api = {
      getAppearance: vi.fn(() => initial.promise),
      subscribeAppearance: vi.fn(() => unsubscribe),
    };

    expect(synchronizeAppearance(api, apply)).toBe(unsubscribe);
    initial.resolve({ colorScheme: "light", accentColor: null });
    await initial.promise;

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith({ colorScheme: "light", accentColor: null });
  });

  it("does not let a stale initial response overwrite a newer event", async () => {
    const initial = deferredAppearance();
    const apply = vi.fn();
    let emit: ((appearance: AppAppearance) => void) | undefined;
    const api = {
      getAppearance: vi.fn(() => initial.promise),
      subscribeAppearance: vi.fn((listener: (appearance: AppAppearance) => void) => {
        emit = listener;
        return () => undefined;
      }),
    };

    synchronizeAppearance(api, apply);
    emit?.({ colorScheme: "dark", accentColor: null });
    initial.resolve({ colorScheme: "light", accentColor: null });
    await initial.promise;

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith({ colorScheme: "dark", accentColor: null });
  });
});
