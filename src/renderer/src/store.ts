import { create } from "zustand";
import { shallow } from "zustand/shallow";
import type {
  Favorite,
  ModuleShortcut,
  WorkspaceSnapshot,
} from "../../shared/model";

export type CommandMode = "switcher" | "link-opener";

function reuseItems<T>(previous: T[], next: T[]): T[] {
  const items = next.map((item, index) => shallow(previous[index], item) ? previous[index] : item);
  return shallow(previous, items) ? previous : items;
}

function reconcileSnapshot(previous: WorkspaceSnapshot | null, next: WorkspaceSnapshot): WorkspaceSnapshot {
  if (!previous) return next;
  const productRegionIds = {
    ack: reuseItems(previous.productRegionIds.ack, next.productRegionIds.ack),
    kafka: reuseItems(previous.productRegionIds.kafka, next.productRegionIds.kafka),
    mse: reuseItems(previous.productRegionIds.mse, next.productRegionIds.mse),
  };
  const snapshot = {
    ...next,
    tabs: reuseItems(previous.tabs, next.tabs),
    favorites: reuseItems(previous.favorites, next.favorites),
    moduleShortcuts: reuseItems(previous.moduleShortcuts, next.moduleShortcuts),
    recentlyClosedTabs: reuseItems(previous.recentlyClosedTabs, next.recentlyClosedTabs),
    recentVisits: reuseItems(previous.recentVisits, next.recentVisits),
    selectedProducts: reuseItems(previous.selectedProducts, next.selectedProducts),
    productRegionIds: shallow(previous.productRegionIds, productRegionIds) ? previous.productRegionIds : productRegionIds,
    windowBounds: shallow(previous.windowBounds, next.windowBounds) ? previous.windowBounds : next.windowBounds,
  };
  return shallow(previous, snapshot) ? previous : snapshot;
}

interface RendererState {
  snapshot: WorkspaceSnapshot | null;
  commandMode: CommandMode | null;
  productSettingsOpen: boolean;
  loginCredentialsOpen: boolean;
  favoriteEditorOpen: boolean;
  favoriteEditorId: string | null;
  moduleShortcutEditorOpen: boolean;
  moduleShortcutEditorId: string | null;
  logoutConfirmOpen: boolean;
  actionError: string | null;
  removedFavorite: Favorite | null;
  removedModuleShortcut: ModuleShortcut | null;
  setSnapshot(snapshot: WorkspaceSnapshot): void;
  initializeSnapshot(snapshot: WorkspaceSnapshot): void;
  openCommand(mode: CommandMode): void;
  closeCommand(): void;
  setProductSettingsOpen(open: boolean): void;
  setLoginCredentialsOpen(open: boolean): void;
  setFavoriteEditor(open: boolean, favoriteId?: string | null): void;
  setModuleShortcutEditor(open: boolean, shortcutId?: string | null): void;
  setLogoutConfirmOpen(open: boolean): void;
  setActionError(error: string | null): void;
  setRemovedFavorite(favorite: Favorite | null): void;
  setRemovedModuleShortcut(shortcut: ModuleShortcut | null): void;
}

export const useRendererStore = create<RendererState>((set) => ({
  snapshot: null,
  commandMode: null,
  productSettingsOpen: false,
  loginCredentialsOpen: false,
  favoriteEditorOpen: false,
  favoriteEditorId: null,
  moduleShortcutEditorOpen: false,
  moduleShortcutEditorId: null,
  logoutConfirmOpen: false,
  actionError: null,
  removedFavorite: null,
  removedModuleShortcut: null,
  setSnapshot: (snapshot) => set((state) => {
    const next = reconcileSnapshot(state.snapshot, snapshot);
    return next === state.snapshot ? state : { snapshot: next };
  }),
  initializeSnapshot: (snapshot) => set((state) => state.snapshot ? state : { snapshot }),
  openCommand: (commandMode) => set({ commandMode }),
  closeCommand: () => set({ commandMode: null }),
  setProductSettingsOpen: (productSettingsOpen) => set({ productSettingsOpen }),
  setLoginCredentialsOpen: (loginCredentialsOpen) => set({ loginCredentialsOpen }),
  setFavoriteEditor: (favoriteEditorOpen, favoriteEditorId = null) =>
    set({ favoriteEditorOpen, favoriteEditorId }),
  setModuleShortcutEditor: (moduleShortcutEditorOpen, moduleShortcutEditorId = null) =>
    set({ moduleShortcutEditorOpen, moduleShortcutEditorId }),
  setLogoutConfirmOpen: (logoutConfirmOpen) => set({ logoutConfirmOpen }),
  setActionError: (actionError) => set({ actionError }),
  setRemovedFavorite: (removedFavorite) => set({ removedFavorite }),
  setRemovedModuleShortcut: (removedModuleShortcut) => set({ removedModuleShortcut }),
}));
