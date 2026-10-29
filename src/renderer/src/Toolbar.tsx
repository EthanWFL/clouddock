import { ArrowLeft, ArrowRight, BookmarkPlus, CircleAlert, ClipboardCopy, Copy, Ellipsis, ExternalLink, Globe2, Link, RefreshCw, Search, Star, X } from "lucide-react";
import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { type WorkspaceTab } from "../../shared/model";
import { getProductContextLabel } from "../../shared/workspace-display";
import { parseConsoleTarget, normalizeConsoleUrl } from "../../shared/console-url";
import { isAllowedAuthHost } from "../../shared/navigation-policy";
import { copyDiagnostics, copyWorkspaceContext, removeFavoriteWithUndo, runViewAction, runWorkspaceAction } from "./actions";
import { ProductIcon } from "./ProductIcon";
import { useRendererStore } from "./store";

interface ToolbarIconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> {
  label: string;
  tooltip?: string;
  tooltipAlign?: "center" | "end";
}

function ToolbarIconButton({
  label,
  tooltip = label,
  tooltipAlign = "center",
  className = "",
  children,
  ...buttonProps
}: ToolbarIconButtonProps) {
  return (
    <span className="toolbar-tooltip" data-tooltip={tooltip} data-align={tooltipAlign}>
      <button
        {...buttonProps}
        type="button"
        className={`icon-button ${className}`.trim()}
        aria-label={label}
        title={tooltip}
      >
        {children}
      </button>
    </span>
  );
}

function ToolbarFeedback({ notice }: { notice: string | null }) {
  const actionError = useRendererStore((state) => state.actionError);
  const removedFavorite = useRendererStore((state) => state.removedFavorite);
  const removedModuleShortcut = useRendererStore((state) => state.removedModuleShortcut);
  const setActionError = useRendererStore((state) => state.setActionError);
  const setRemovedFavorite = useRendererStore((state) => state.setRemovedFavorite);
  const setRemovedModuleShortcut = useRendererStore((state) => state.setRemovedModuleShortcut);

  if (actionError) {
    return (
      <div className="toolbar-feedback error" role="alert">
        <CircleAlert size={14} />
        <span title={actionError}>{actionError}</span>
        <button aria-label="关闭错误" onClick={() => setActionError(null)}><X size={13} /></button>
      </div>
    );
  }
  if (removedModuleShortcut) {
    return (
      <div className="toolbar-feedback" role="status">
        <span title={removedModuleShortcut.name}>已删除快捷入口“{removedModuleShortcut.name}”</span>
        <button className="notice-action" aria-label={`撤销删除 ${removedModuleShortcut.name}`} onClick={() => {
          void runWorkspaceAction({
            type: "restore-module-shortcut",
            shortcutId: removedModuleShortcut.id,
          }).then((restored) => {
            if (restored) setRemovedModuleShortcut(null);
          });
        }}>撤销</button>
        <button aria-label="关闭快捷入口撤销提示" onClick={() => setRemovedModuleShortcut(null)}><X size={13} /></button>
      </div>
    );
  }
  if (removedFavorite) {
    return (
      <div className="toolbar-feedback" role="status">
        <span title={removedFavorite.name}>已删除收藏“{removedFavorite.name}”</span>
        <button className="notice-action" aria-label={`撤销删除 ${removedFavorite.name}`} onClick={() => {
          void runWorkspaceAction({
            type: "restore-favorite",
            favoriteId: removedFavorite.id,
          }).then((restored) => {
            if (restored) setRemovedFavorite(null);
          });
        }}>撤销</button>
        <button aria-label="关闭收藏撤销提示" onClick={() => setRemovedFavorite(null)}><X size={13} /></button>
      </div>
    );
  }
  if (notice) {
    return (
      <div className="toolbar-feedback" role="status">
        <CircleAlert size={14} />
        <span title={notice}>{notice}</span>
        <button aria-label="关闭提示" onClick={() => void runWorkspaceAction({ type: "set-notice", notice: null })}><X size={13} /></button>
      </div>
    );
  }
  return null;
}

export const Toolbar = memo(function Toolbar({ active, onOpenFind }: { active: WorkspaceTab | undefined; onOpenFind: () => void }) {
  const snapshot = useRendererStore(useShallow(({ snapshot }) => ({ favorites: snapshot!.favorites, notice: snapshot!.notice })));
  const openCommand = useRendererStore((state) => state.openCommand);
  const setFavoriteEditor = useRendererStore((state) => state.setFavoriteEditor);
  const setModuleShortcutEditor = useRendererStore((state) => state.setModuleShortcutEditor);
  const setLogoutOpen = useRendererStore((state) => state.setLogoutConfirmOpen);
  const setLoginCredentialsOpen = useRendererStore((state) => state.setLoginCredentialsOpen);
  const target = active ? parseConsoleTarget(active.url) : null;
  const canCopyContext = Boolean(active && target && !active.isAuthenticating && !active.externalHostname);
  const isFavorite = active ? snapshot.favorites.some((favorite) => normalizeConsoleUrl(favorite.url) === normalizeConsoleUrl(active.url)) : false;
  const canSaveModuleShortcut = Boolean(active && (active.product === "codeup" || active.product === "sls") && !active.isAuthenticating && target);
  const needsLogin = Boolean(
    active?.isAuthenticating
    && active.externalHostname
    && isAllowedAuthHost(active.externalHostname),
  );

  const toggleFavorite = () => {
    if (!active) return;
    const existing = snapshot.favorites.find((favorite) => normalizeConsoleUrl(favorite.url) === normalizeConsoleUrl(active.url));
    if (existing) void removeFavoriteWithUndo(existing);
    else setFavoriteEditor(true);
  };
  const openMoreMenu = async () => {
    try {
      const action = await window.opsdock.showNativeMenu({ type: "app" });
      if (action === "credentials") setLoginCredentialsOpen(true);
      else if (action === "logout") setLogoutOpen(true);
      else if (action === "diagnostics") await copyDiagnostics();
    } catch {
      useRendererStore.getState().setActionError("无法打开更多操作，请重试");
    }
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="控制台操作">
      <div className="toolbar-group" role="group" aria-label="导航">
        <ToolbarIconButton label="后退" tooltip="后退 (⌘[)" aria-keyshortcuts="Meta+[" disabled={!active?.canGoBack} onClick={() => void runViewAction({ type: "back" })}><ArrowLeft size={16} /></ToolbarIconButton>
        <ToolbarIconButton label="前进" tooltip="前进 (⌘])" aria-keyshortcuts="Meta+]" disabled={!active?.canGoForward} onClick={() => void runViewAction({ type: "forward" })}><ArrowRight size={16} /></ToolbarIconButton>
        <ToolbarIconButton label="刷新" tooltip="刷新当前页面 (⌘R)" aria-keyshortcuts="Meta+R" disabled={!active} onClick={() => void runViewAction({ type: "reload" })}><RefreshCw size={16} /></ToolbarIconButton>
        <ToolbarIconButton label="打开链接" tooltip="搜索或打开阿里云控制台链接 (⌘T)" aria-keyshortcuts="Meta+T" onClick={() => openCommand("link-opener")}><Link size={16} /></ToolbarIconButton>
      </div>
      <button className="command-trigger" onClick={() => openCommand("switcher")}>
        <Search size={15} /><span>快速切换</span><kbd>⌘K</kbd>
      </button>
      <div className="toolbar-spacer" />
      <ToolbarFeedback notice={snapshot.notice} />
      {active && (
        active.externalHostname
          ? <span className="toolbar-context external-host" title={active.externalHostname} aria-label={`当前外部域名：${active.externalHostname}`}><Globe2 size={14} />{active.externalHostname}</span>
          : <span className="toolbar-context" data-product={active.product}><ProductIcon product={active.product} />{getProductContextLabel(active.product, active.regionId)}</span>
      )}
      <div className="toolbar-group" role="group" aria-label="页面操作">
        <ToolbarIconButton label="页内查找" tooltip="页内查找 (⌘F)" aria-keyshortcuts="Meta+F" disabled={!active} onClick={onOpenFind}>
          <Search size={16} />
        </ToolbarIconButton>
        {(active?.product === "codeup" || active?.product === "sls") && (
          <ToolbarIconButton
            label="保存模块快捷入口"
            tooltip={canSaveModuleShortcut ? "保存模块快捷入口" : "当前页面不可保存为快捷入口"}
            disabled={!canSaveModuleShortcut}
            onClick={() => setModuleShortcutEditor(true)}
          >
            <BookmarkPlus size={16} />
          </ToolbarIconButton>
        )}
        <ToolbarIconButton
          label={isFavorite ? "取消收藏" : "收藏当前页面"}
          tooltip={isFavorite ? "取消收藏 (⌘D)" : target && !active?.isAuthenticating ? "收藏当前页面 (⌘D)" : "当前页面不可收藏"}
          aria-keyshortcuts="Meta+D"
          aria-pressed={isFavorite}
          className={isFavorite ? "selected" : ""}
          disabled={!active || active.isAuthenticating || (!target && !isFavorite)}
          onClick={toggleFavorite}
        >
          <Star size={16} fill={isFavorite ? "currentColor" : "none"} />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="复制当前链接"
          tooltip={active?.isAuthenticating ? "登录或外部页面链接不可复制" : "复制当前链接"}
          disabled={!active || active.isAuthenticating}
          onClick={() => void runViewAction({ type: "copy-link" })}
        >
          <Copy size={16} />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="复制工作区上下文"
          tooltip={canCopyContext ? "复制当前页面与筛选后的任务队列" : active ? "登录或外部页面不能复制工作区上下文" : "当前没有可复制的工作区页面"}
          disabled={!canCopyContext}
          onClick={() => void copyWorkspaceContext()}
        >
          <ClipboardCopy size={16} />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="用默认浏览器打开"
          tooltip={active?.isAuthenticating ? "登录或外部页面不能在浏览器中打开" : "用默认浏览器打开"}
          disabled={!active || active.isAuthenticating}
          onClick={() => void runViewAction({ type: "open-system" })}
        >
          <ExternalLink size={16} />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="更多操作"
          tooltip={needsLogin ? "当前需要登录，可在更多操作中管理账号密码" : "更多操作：账号密码、诊断与退出登录"}
          tooltipAlign="end"
          aria-haspopup="menu"
          className={needsLogin ? "needs-attention" : ""}
          onClick={() => void openMoreMenu()}
        >
          <Ellipsis size={16} />
        </ToolbarIconButton>
      </div>
    </div>
  );
});
