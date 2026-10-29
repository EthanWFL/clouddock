import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  channel: "",
  handler: null as null | ((event: unknown, input: unknown) => void),
}));

vi.mock("electron", () => ({
  ipcRenderer: {
    on: vi.fn((channel: string, handler: (event: unknown, input: unknown) => void) => {
      electronMocks.channel = channel;
      electronMocks.handler = handler;
    }),
  },
}));

function makeVisible(input: HTMLInputElement): void {
  Object.defineProperty(input, "getClientRects", {
    configurable: true,
    value: () => ({ length: 1 }),
  });
}

beforeEach(async () => {
  vi.resetModules();
  electronMocks.channel = "";
  electronMocks.handler = null;
  document.body.innerHTML = '<form><input autocomplete="username"></form>';
  vi.stubGlobal("location", { protocol: "https:", hostname: "account.aliyun.com" });
  makeVisible(document.querySelector("input")!);
  await import("../../src/preload/login-autofill");
});

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.unstubAllGlobals();
});

describe("login autofill preload", () => {
  it("fills a two-step SPA form without submitting it", async () => {
    const form = document.querySelector("form")!;
    const username = document.querySelector<HTMLInputElement>("input")!;
    const inputEvents = vi.fn();
    const changeEvents = vi.fn();
    const submits = vi.fn((event: Event) => event.preventDefault());
    form.addEventListener("input", inputEvents);
    form.addEventListener("change", changeEvents);
    form.addEventListener("submit", submits);

    expect(electronMocks.channel).toBe("credentials:fill");
    electronMocks.handler?.({}, { username: "ram-user", password: "secret" });
    expect(username.value).toBe("ram-user");

    const password = document.createElement("input");
    password.type = "password";
    makeVisible(password);
    form.append(password);

    await vi.waitFor(() => expect(password.value).toBe("secret"));
    expect(inputEvents).toHaveBeenCalledTimes(2);
    expect(changeEvents).toHaveBeenCalledTimes(2);
    expect(submits).not.toHaveBeenCalled();
  });

  it("preserves existing values and ignores unrelated text fields", () => {
    const username = document.querySelector<HTMLInputElement>("input")!;
    username.value = "existing-user";
    const tenant = document.createElement("input");
    tenant.type = "text";
    makeVisible(tenant);
    const password = document.createElement("input");
    password.type = "password";
    password.value = "existing-password";
    makeVisible(password);
    document.body.append(tenant, password);

    electronMocks.handler?.({}, { username: "ram-user", password: "secret" });

    expect(username.value).toBe("existing-user");
    expect(password.value).toBe("existing-password");
    expect(tenant.value).toBe("");
  });

  it("fills a password field when an SPA makes it visible", async () => {
    const password = document.createElement("input");
    password.type = "password";
    password.style.display = "none";
    makeVisible(password);
    document.body.append(password);

    electronMocks.handler?.({}, { username: "ram-user", password: "secret" });
    expect(password.value).toBe("");

    password.style.display = "block";

    await vi.waitFor(() => expect(password.value).toBe("secret"));
  });
});
