import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

export interface PersistenceFileSystem {
  readFile(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: string, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export const nodeFileSystem: PersistenceFileSystem = {
  readFile: (path) => fs.readFile(path, "utf8"),
  mkdir: async (path) => { await fs.mkdir(path, { recursive: true }); },
  writeFile: (path, data, mode) => fs.writeFile(path, data, { encoding: "utf8", flag: "w", mode }),
  chmod: (path, mode) => fs.chmod(path, mode),
  rename: (from, to) => fs.rename(from, to),
  unlink: (path) => fs.unlink(path),
};

export function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function writePrivateFileAtomically(
  filePath: string,
  contents: string,
  fileSystem: PersistenceFileSystem = nodeFileSystem,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fileSystem.mkdir(dirname(filePath));
  let temporaryFileExists = true;
  try {
    await fileSystem.writeFile(temporaryPath, contents, 0o600);
    await fileSystem.chmod(temporaryPath, 0o600);
    await fileSystem.rename(temporaryPath, filePath);
    temporaryFileExists = false;
    await fileSystem.chmod(filePath, 0o600);
  } finally {
    if (temporaryFileExists) {
      try {
        await fileSystem.unlink(temporaryPath);
      } catch {
        // Keep the original failure, including partial writes, available to the caller.
      }
    }
  }
}
