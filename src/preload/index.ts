import { contextBridge, ipcRenderer } from "electron";
import type { AppAppearance, LoginCredentialStatus, OpsDockApi } from "../shared/api";
import { isConsoleShortcut, type ConsoleShortcut } from "../shared/console-shortcut";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import type { ViewAction, ViewBounds } from "../shared/ipc";
import type { WorkspaceCommand, WorkspaceSnapshot } from "../shared/model";

const api: OpsDockApi = {
  getAppearance: () => ipcRenderer.invoke(IPC_CHANNELS.appearanceGet),
  subscribeAppearance: (listener: (appearance: AppAppearance) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, appearance: AppAppearance) => listener(appearance);
    ipcRenderer.on(IPC_CHANNELS.appearanceChanged, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.appearanceChanged, handler);
  },
  getWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceGet),
  dispatch: (command: WorkspaceCommand) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceDispatch, command),
  subscribeWorkspace: (listener: (snapshot: WorkspaceSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: WorkspaceSnapshot) => listener(snapshot);
    ipcRenderer.on(IPC_CHANNELS.workspaceChanged, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.workspaceChanged, handler);
  },
  subscribeConsoleShortcut: (listener: (shortcut: ConsoleShortcut) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, input: unknown) => {
      if (isConsoleShortcut(input)) listener(input);
    };
    ipcRenderer.on(IPC_CHANNELS.consoleShortcut, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.consoleShortcut, handler);
  },
  setViewBounds: (bounds: ViewBounds) => ipcRenderer.send(IPC_CHANNELS.viewBounds, bounds),
  performViewAction: (action: ViewAction) =>
    ipcRenderer.invoke(IPC_CHANNELS.viewAction, action),
  copyDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.diagnosticsCopy),
  copyWorkspaceContext: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceContextCopy),
  retryFailedTabs: () => ipcRenderer.invoke(IPC_CHANNELS.retryFailedTabs),
  logout: () => ipcRenderer.invoke(IPC_CHANNELS.sessionLogout),
  getLoginCredentials: () => ipcRenderer.invoke(IPC_CHANNELS.credentialsGet),
  saveLoginCredentials: (credentials: { username: string; password: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.credentialsSave, credentials),
  clearLoginCredentials: () => ipcRenderer.invoke(IPC_CHANNELS.credentialsClear),
  getClipboardConsoleUrls: () => ipcRenderer.invoke(IPC_CHANNELS.clipboardConsoleUrls),
  getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.appVersion),
  showNativeMenu: (request) => ipcRenderer.invoke(IPC_CHANNELS.nativeMenu, request),
};

contextBridge.exposeInMainWorld("opsdock", api);
