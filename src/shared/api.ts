import type { NativeMenuAction, NativeMenuRequest, PageFindResult, ViewAction, ViewBounds } from "./ipc";
import type { ConsoleShortcut } from "./console-shortcut";
import type { WorkspaceCommand, WorkspaceResult, WorkspaceSnapshot } from "./model";

export interface AppAppearance {
  colorScheme: "light" | "dark";
  accentColor: string | null;
}

export interface LoginCredentialStatus {
  configured: boolean;
  username: string | null;
}

export interface RetryFailedTabsResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

export interface OpsDockApi {
  getAppearance(): Promise<AppAppearance>;
  subscribeAppearance(listener: (appearance: AppAppearance) => void): () => void;
  getWorkspace(): Promise<WorkspaceSnapshot>;
  dispatch(command: WorkspaceCommand): Promise<WorkspaceResult>;
  subscribeWorkspace(listener: (snapshot: WorkspaceSnapshot) => void): () => void;
  subscribeConsoleShortcut(listener: (shortcut: ConsoleShortcut) => void): () => void;
  setViewBounds(bounds: ViewBounds): void;
  performViewAction(action: ViewAction): Promise<PageFindResult | null>;
  copyDiagnostics(): Promise<void>;
  copyWorkspaceContext(): Promise<void>;
  retryFailedTabs(): Promise<RetryFailedTabsResult>;
  logout(): Promise<WorkspaceResult>;
  getLoginCredentials(): Promise<LoginCredentialStatus>;
  saveLoginCredentials(credentials: { username: string; password: string }): Promise<LoginCredentialStatus>;
  clearLoginCredentials(): Promise<LoginCredentialStatus>;
  getClipboardConsoleUrls(): Promise<string[]>;
  getVersion(): Promise<string>;
  showNativeMenu(request: NativeMenuRequest): Promise<NativeMenuAction | null>;
}
