import { safeStorage } from "electron";
import { promises as fs } from "node:fs";
import { isMissingFile, writePrivateFileAtomically } from "../../private-file";

export interface LoginCredentials {
  username: string;
  password: string;
}

interface EncryptedCredentials {
  username: string;
  password: string;
}

export class CredentialStore {
  private pendingWrite: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  async status(): Promise<{ configured: boolean; username: string | null }> {
    const credentials = await this.get();
    return { configured: Boolean(credentials), username: credentials?.username ?? null };
  }

  async get(): Promise<LoginCredentials | null> {
    await this.pendingWrite;
    let contents: string;
    try {
      contents = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new Error("无法读取已保存的登录信息");
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统钥匙串不可用，无法读取登录信息");
    try {
      const stored = JSON.parse(contents) as EncryptedCredentials;
      return {
        username: safeStorage.decryptString(Buffer.from(stored.username, "base64")),
        password: safeStorage.decryptString(Buffer.from(stored.password, "base64")),
      };
    } catch {
      throw new Error("已保存的登录信息损坏或无法解密，请重新保存或清除");
    }
  }

  async save(credentials: LoginCredentials): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统钥匙串不可用，无法保存登录信息");
    const encrypted = {
      username: safeStorage.encryptString(credentials.username).toString("base64"),
      password: safeStorage.encryptString(credentials.password).toString("base64"),
    };
    const write = this.pendingWrite.then(() => writePrivateFileAtomically(this.filePath, JSON.stringify(encrypted)));
    this.pendingWrite = write.catch(() => undefined);
    await write;
  }

  async clear(): Promise<void> {
    const write = this.pendingWrite.then(async () => {
      try {
        await fs.unlink(this.filePath);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    });
    this.pendingWrite = write.catch(() => undefined);
    await write;
  }
}
