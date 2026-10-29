import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
    decryptString: vi.fn((value: Buffer) => {
      const text = value.toString();
      if (!text.startsWith("encrypted:")) throw new Error("bad encrypted data");
      return text.slice("encrypted:".length);
    }),
  },
}));

import { safeStorage } from "electron";
import { CredentialStore } from "../../src/main/modules/console-session/credential-store";

const directories: string[] = [];
async function harness() {
  const directory = await fs.mkdtemp(join(tmpdir(), "opsdock-credentials-"));
  directories.push(directory);
  const filePath = join(directory, "credentials.json");
  return { directory, filePath, store: new CredentialStore(filePath) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
  await Promise.all(directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

describe("CredentialStore", () => {
  it("atomically saves encrypted credentials with private permissions", async () => {
    const { store, filePath, directory } = await harness();
    await expect(store.status()).resolves.toEqual({ configured: false, username: null });
    const credentials = { username: "ram-user", password: "private-password" };
    await store.save(credentials);
    await expect(store.get()).resolves.toEqual(credentials);
    expect(await fs.readFile(filePath, "utf8")).not.toContain(credentials.password);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(directory)).toEqual(["credentials.json"]);
  });

  it("preserves the previous credentials and removes the temporary file after a failed replacement", async () => {
    const { store, filePath, directory } = await harness();
    await store.save({ username: "original", password: "original-password" });
    const original = await fs.readFile(filePath, "utf8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk failure"));
    await expect(store.save({ username: "replacement", password: "new-password" })).rejects.toThrow("disk failure");
    expect(await fs.readFile(filePath, "utf8")).toBe(original);
    expect(await fs.readdir(directory)).toEqual(["credentials.json"]);
    await expect(store.status()).resolves.toEqual({ configured: true, username: "original" });
  });

  it("orders clear after an in-flight save", async () => {
    const { store } = await harness();
    await Promise.all([store.save({ username: "user", password: "password" }), store.clear()]);
    await expect(store.get()).resolves.toBeNull();
  });

  it("distinguishes corrupt, inaccessible and unavailable-keychain files from a missing file", async () => {
    const { store, filePath } = await harness();
    await fs.writeFile(filePath, "invalid-json");
    await expect(store.status()).rejects.toThrow("损坏或无法解密");
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(store.get()).rejects.toThrow("无法读取");
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
    await expect(store.status()).rejects.toThrow("系统钥匙串不可用");
    await store.clear();
    await expect(store.get()).resolves.toBeNull();
  });
});
