import { session, type Session } from "electron";
import {
  isAllowedAuthHost,
  isAllowedConsoleHost,
  isTrustedConsoleDownloadSource,
} from "../../../shared/navigation-policy";

const SESSION_PARTITION = "persist:aliyun";
const CLIPBOARD_WRITE_PERMISSION = "clipboard-sanitized-write";

function isTrustedClipboardOrigin(originValue: string): boolean {
  try {
    const origin = new URL(originValue);
    return (
      origin.protocol === "https:" &&
      (isAllowedConsoleHost(origin.hostname) || isAllowedAuthHost(origin.hostname))
    );
  } catch {
    return false;
  }
}

export interface ConsoleSessionOptions {
  partition?: string;
  allowTestServer?: boolean;
  onDownloadBlocked?: () => void;
  onDownloadStatus?: (status: ConsoleDownloadStatus) => void;
}

export type ConsoleDownloadStatus =
  | { type: "started"; fileName: string }
  | { type: "progress"; fileName: string; percent: number }
  | { type: "completed"; fileName: string }
  | { type: "cancelled"; fileName: string }
  | { type: "failed"; fileName: string };

export class ConsoleSession {
  readonly partition: string;
  readonly electronSession: Session;
  private policiesInstalled = false;

  constructor(private readonly options: ConsoleSessionOptions = {}) {
    this.partition = options.partition ?? SESSION_PARTITION;
    this.electronSession = session.fromPartition(this.partition);
  }

  installPolicies(): void {
    if (this.policiesInstalled) return;
    this.policiesInstalled = true;

    this.electronSession.setPermissionCheckHandler(
      (_webContents, permission, requestingOrigin) =>
        permission === CLIPBOARD_WRITE_PERMISSION && isTrustedClipboardOrigin(requestingOrigin),
    );

    this.electronSession.setPermissionRequestHandler(
      (_webContents, permission, callback, details) => {
        const allowed =
          permission === CLIPBOARD_WRITE_PERMISSION &&
          isTrustedClipboardOrigin(details.requestingUrl);
        callback(allowed);
      },
    );

    this.electronSession.setDevicePermissionHandler(() => false);
    this.electronSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    this.electronSession.setSpellCheckerEnabled(false);

    this.electronSession.on("will-download", (event, item, webContents) => {
      const trustedSource = isTrustedConsoleDownloadSource(
        webContents.getURL(),
        { allowTestServer: this.options.allowTestServer },
      );
      if (!trustedSource) {
        event.preventDefault();
        this.options.onDownloadBlocked?.();
        return;
      }

      item.setSaveDialogOptions({
        title: "保存控制台文件",
        buttonLabel: "保存",
      });

      const fileName = item.getFilename() || "控制台文件";
      let lastProgressBucket = 0;
      this.options.onDownloadStatus?.({ type: "started", fileName });
      item.on("updated", (_itemEvent, state) => {
        if (state !== "progressing" || item.isPaused()) return;
        const totalBytes = item.getTotalBytes();
        if (totalBytes <= 0) return;
        const percent = Math.min(100, Math.floor((item.getReceivedBytes() / totalBytes) * 100));
        const bucket = Math.floor(percent / 10) * 10;
        if (bucket <= lastProgressBucket || bucket >= 100) return;
        lastProgressBucket = bucket;
        this.options.onDownloadStatus?.({ type: "progress", fileName, percent: bucket });
      });
      item.once("done", (_itemEvent, state) => {
        const type = state === "completed"
          ? "completed"
          : state === "cancelled"
            ? "cancelled"
            : "failed";
        this.options.onDownloadStatus?.({ type, fileName });
      });
    });
  }

  async clearLoginState(): Promise<void> {
    await this.electronSession.clearData();
    await this.electronSession.clearAuthCache();
    await this.electronSession.closeAllConnections();
  }

  async flushCookies(): Promise<void> {
    this.electronSession.flushStorageData();
    await this.electronSession.cookies.flushStore();
  }
}
