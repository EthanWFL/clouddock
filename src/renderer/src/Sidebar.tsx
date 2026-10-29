import { BookmarkPlus, ChevronDown, ChevronRight, Ellipsis, Home, LayoutGrid, PanelLeftClose, PanelLeftOpen, Star } from "lucide-react";
import { memo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { type Favorite } from "../../shared/model";
import type { NativeMenuRequest } from "../../shared/ipc";
import { GLOBAL_PRODUCT_ENTRIES, GLOBAL_PRODUCTS, getProductRegionIds, getTabModuleShortcut, productLabel, REGIONAL_PRODUCTS, type GlobalProductEntry } from "../../shared/workspace-display";
import { getRegionShortName } from "../../shared/regions";
import { CONSOLE_HOME_URL, normalizeConsoleUrl } from "../../shared/console-url";
import { openGlobalProductEntry, removeFavoriteWithUndo, removeModuleShortcutWithUndo, runWorkspaceAction } from "./actions";
import { ConsoleEntryIcon, ProductIcon } from "./ProductIcon";
import { useRendererStore } from "./store";

export const Sidebar = memo(function Sidebar() {
  const snapshot = useRendererStore(useShallow(({ snapshot }) => ({
    sidebarCollapsed: snapshot!.sidebarCollapsed,
    favorites: snapshot!.favorites,
    moduleShortcuts: snapshot!.moduleShortcuts,
    selectedProducts: snapshot!.selectedProducts,
    productRegionIds: snapshot!.productRegionIds,
  })));
  const collapsed = snapshot.sidebarCollapsed;
  const activeTab = useRendererStore(useShallow(({ snapshot }) => {
    const active = snapshot?.tabs.find((tab) => tab.id === snapshot.activeTabId);
    return active ? { url: active.url, product: active.product, regionId: active.regionId, moduleShortcutId: active.moduleShortcutId } : null;
  }));
  const setProductOpen = useRendererStore((state) => state.setProductSettingsOpen);
  const setFavoriteEditor = useRendererStore((state) => state.setFavoriteEditor);
  const setModuleShortcutEditor = useRendererStore((state) => state.setModuleShortcutEditor);
  const [regionalSections, setRegionalSections] = useState<Record<(typeof REGIONAL_PRODUCTS)[number], boolean>>(
    () => Object.fromEntries(REGIONAL_PRODUCTS.map((product) => [product, true])) as Record<(typeof REGIONAL_PRODUCTS)[number], boolean>,
  );

  const openFavorite = (favorite: Favorite) => runWorkspaceAction({
    type: "open-url",
    product: favorite.product,
    regionId: favorite.regionId,
    url: favorite.url,
    title: favorite.name,
  });
  const openItemMenu = async (request: Exclude<NativeMenuRequest, { type: "app" }>) => {
    try {
      const action = await window.opsdock.showNativeMenu(request);
      const current = useRendererStore.getState().snapshot!;
      const favorite = request.type === "favorite" ? current.favorites.find((item) => item.id === request.id) : undefined;
      const shortcut = request.type === "module-shortcut" ? current.moduleShortcuts.find((item) => item.id === request.id) : undefined;
      if (!action || (!favorite && !shortcut)) return;
      if (action === "rename") {
        if (favorite) setFavoriteEditor(true, favorite.id);
        else setModuleShortcutEditor(true, shortcut!.id);
      } else if (action === "remove") {
        if (favorite) await removeFavoriteWithUndo(favorite);
        else await removeModuleShortcutWithUndo(shortcut!);
      } else if (action === "move-up" || action === "move-down") {
        const items = favorite ? current.favorites : current.moduleShortcuts.filter((item) => item.product === shortcut!.product);
        const index = items.findIndex((item) => item.id === request.id);
        const target = items[index + (action === "move-up" ? -1 : 1)];
        if (!target) return;
        if (favorite) await runWorkspaceAction({ type: "move-favorite", favoriteId: favorite.id, toIndex: current.favorites.findIndex((item) => item.id === target.id) });
        else await runWorkspaceAction({ type: "move-module-shortcut", shortcutId: shortcut!.id, toIndex: current.moduleShortcuts.findIndex((item) => item.id === target.id) });
      }
    } catch {
      useRendererStore.getState().setActionError("无法打开条目操作，请重试");
    }
  };
  const activeNormalizedUrl = activeTab ? normalizeConsoleUrl(activeTab.url) : null;
  const activeShortcut = activeTab ? getTabModuleShortcut(activeTab, snapshot.moduleShortcuts) : undefined;
  const isGlobalEntrySelected = (
    entry: GlobalProductEntry,
    productEntries: readonly GlobalProductEntry[],
  ) => {
    if (activeTab?.product !== entry.product || !activeNormalizedUrl) return false;
    if (activeNormalizedUrl === CONSOLE_HOME_URL || activeShortcut) return false;
    if (entry.url) return normalizeConsoleUrl(entry.url) === activeNormalizedUrl;
    return !productEntries.some(
      (candidate) => candidate.url && normalizeConsoleUrl(candidate.url) === activeNormalizedUrl,
    );
  };

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="sidebar-brand">
        {!collapsed && <strong>CloudDock</strong>}
        <button className="icon-button sidebar-toggle" title={collapsed ? "展开侧栏" : "折叠侧栏"} aria-label={collapsed ? "展开侧栏" : "折叠侧栏"} onClick={() => void runWorkspaceAction({ type: "set-sidebar-collapsed", collapsed: !collapsed })}>
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>

      <div className="sidebar-scroll">
        {REGIONAL_PRODUCTS.filter((product) => snapshot.selectedProducts.includes(product)).map((product) => {
          const sectionOpen = regionalSections[product];
          const sectionLabel = productLabel(product);
          return (
            <section className="nav-section" data-product={product} key={product}>
              {!collapsed && (
                <div className="nav-section-heading">
                  <h2><ProductIcon product={product} />{sectionLabel}</h2>
                  <button
                    className="nav-section-toggle"
                    aria-controls={`regional-entries-${product}`}
                    aria-expanded={sectionOpen}
                    aria-label={`${sectionOpen ? "折叠" : "展开"} ${sectionLabel} 地域`}
                    title={`${sectionOpen ? "折叠" : "展开"} ${sectionLabel} 地域`}
                    onClick={() => setRegionalSections((current) => ({
                      ...current,
                      [product]: !current[product],
                    }))}
                  >
                    {sectionOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                </div>
              )}
              <div
                className="nav-list"
                hidden={!collapsed && !sectionOpen}
                id={`regional-entries-${product}`}
              >
                {getProductRegionIds(product, snapshot.productRegionIds).map((regionId) => {
                  const selected = activeTab?.product === product && activeTab.regionId === regionId;
                  const regionName = getRegionShortName(regionId);
                  return (
                    <button
                      key={`${product}-${regionId}`}
                      data-product={product}
                      className={`nav-item product-entry ${selected ? "selected" : ""}`}
                      title={`${productLabel(product)} · ${regionName}`}
                      aria-label={`${productLabel(product)} · ${regionName}`}
                      aria-current={selected ? "page" : undefined}
                      onClick={() => void runWorkspaceAction({ type: "open-entry", product, regionId })}
                    >
                      {collapsed
                        ? <><ProductIcon product={product} size={14} /><span className="collapsed-region-label" aria-hidden="true">{regionName.slice(0, 2)}</span></>
                        : <><span>{regionName}</span><ChevronRight size={14} /></>}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}

        {GLOBAL_PRODUCTS.filter((product) => snapshot.selectedProducts.includes(product)).map((product) => {
          const productEntries = GLOBAL_PRODUCT_ENTRIES.filter((entry) => entry.product === product);
          const shortcuts = snapshot.moduleShortcuts.filter((shortcut) => shortcut.product === product);
          return (
            <section className="nav-section" data-product={product} key={product}>
              {!collapsed && <h2><ProductIcon product={product} />{productLabel(product)}</h2>}
              <div className="nav-list">
                {productEntries.map((entry, index) => {
                  const selected = isGlobalEntrySelected(entry, productEntries);
                  const title = index === 0
                    ? productLabel(product)
                    : `${productLabel(product)} · ${entry.label}`;
                  return (
                    <button
                      data-product={product}
                      key={`${product}-${entry.url ?? "entry"}`}
                      className={`nav-item product-entry ${selected ? "selected" : ""}`}
                      title={title}
                      aria-label={title}
                      aria-current={selected ? "page" : undefined}
                      onClick={() => void openGlobalProductEntry(entry)}
                    >
                      {collapsed
                        ? <ConsoleEntryIcon product={product} query={Boolean(entry.url)} size={15} />
                        : <>
                          {productEntries.length > 1 && (
                            <ConsoleEntryIcon product={product} query={Boolean(entry.url)} size={14} />
                          )}
                          <span>{entry.label}</span><ChevronRight size={14} />
                        </>}
                    </button>
                  );
                })}
                {shortcuts.map((shortcut) => {
                  const selected = activeShortcut?.id === shortcut.id;
                  return (
                    <div className="favorite-row module-shortcut-row" key={shortcut.id}>
                      <button
                        data-product={product}
                        className={`nav-item favorite-main ${selected ? "selected" : ""}`}
                        title={shortcut.name}
                        aria-label={`${productLabel(product)} · ${shortcut.name}`}
                        aria-current={selected ? "page" : undefined}
                        onClick={() => void runWorkspaceAction({
                          type: "open-url",
                          product,
                          regionId: null,
                          url: shortcut.url,
                          title: shortcut.name,
                        })}
                      >
                        {collapsed
                          ? <BookmarkPlus size={15} />
                          : <><BookmarkPlus size={14} /><span>{shortcut.name}</span></>}
                      </button>
                      {!collapsed && (
                        <div className="favorite-actions">
                          <button className="tiny-icon" title="更多操作" aria-label={`更多操作 ${shortcut.name}`} aria-haspopup="menu" onClick={() => void openItemMenu({ type: "module-shortcut", id: shortcut.id })}><Ellipsis size={15} /></button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}

        {snapshot.favorites.length > 0 && (
          <section className="nav-section favorites-section">
            {!collapsed && <h2><Star size={15} />收藏</h2>}
            <div className="nav-list">
              {snapshot.favorites.map((favorite) => (
                <div className="favorite-row" key={favorite.id}>
                  <button data-product={favorite.product} className="nav-item favorite-main" title={favorite.name} onClick={() => void openFavorite(favorite)}>
                    {collapsed ? <Star size={15} /> : <><ProductIcon product={favorite.product} /><span>{favorite.name}</span></>}
                  </button>
                  {!collapsed && (
                    <div className="favorite-actions">
                      <button className="tiny-icon" title="更多操作" aria-label={`更多操作 ${favorite.name}`} aria-haspopup="menu" onClick={() => void openItemMenu({ type: "favorite", id: favorite.id })}><Ellipsis size={15} /></button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <div className="sidebar-footer">
        <button className="nav-item" title="控制台首页" aria-label="控制台首页" onClick={() => void runWorkspaceAction({ type: "open-console-home" })}>
          <Home size={16} />{!collapsed && <span>控制台首页</span>}
        </button>
        <button className="nav-item" title="管理模块" aria-label="管理模块" onClick={() => setProductOpen(true)}>
          <LayoutGrid size={16} />{!collapsed && <span>管理模块</span>}
        </button>
      </div>
    </aside>
  );
});
