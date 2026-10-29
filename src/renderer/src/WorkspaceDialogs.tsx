import { CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useRendererStore } from "./store";
import { Modal } from "./Modal";

export function FavoriteEditorModal() {
  const snapshot = useRendererStore((state) => state.snapshot)!;
  const favoriteId = useRendererStore((state) => state.favoriteEditorId);
  const setEditor = useRendererStore((state) => state.setFavoriteEditor);
  const favorite = favoriteId ? snapshot.favorites.find((item) => item.id === favoriteId) : null;
  const [targetTabId] = useState(snapshot.activeTabId);
  const active = snapshot.tabs.find((tab) => tab.id === targetTabId);
  const [name, setName] = useState(favorite?.name ?? active?.title ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = favorite
        ? await window.opsdock.dispatch({ type: "rename-favorite", favoriteId: favorite.id, name })
        : active
          ? await window.opsdock.dispatch({ type: "add-favorite", tabId: active.id, name })
          : null;
      if (result?.ok) setEditor(false);
      else setError(result?.error ?? "当前页面无法收藏");
    } catch {
      setError("收藏保存失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={favorite ? "重命名收藏" : "收藏当前页面"} onClose={() => !busy && setEditor(false)}>
      <div className="modal-body">
        <label className="text-field">
          <span>名称</span>
          <input autoFocus disabled={busy} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) void save();
          }} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-actions">
        <button className="secondary-button" disabled={busy} onClick={() => setEditor(false)}>取消</button>
        <button className="primary-button small" disabled={!name.trim() || busy} onClick={save}>
          {busy && <LoaderCircle className="spin" size={15} />}保存
        </button>
      </footer>
    </Modal>
  );
}

export function ModuleShortcutEditorModal() {
  const snapshot = useRendererStore((state) => state.snapshot)!;
  const shortcutId = useRendererStore((state) => state.moduleShortcutEditorId);
  const setEditor = useRendererStore((state) => state.setModuleShortcutEditor);
  const shortcut = shortcutId
    ? snapshot.moduleShortcuts.find((item) => item.id === shortcutId)
    : null;
  const [targetTabId] = useState(snapshot.activeTabId);
  const active = snapshot.tabs.find((tab) => tab.id === targetTabId);
  const [name, setName] = useState(shortcut?.name ?? active?.title ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = shortcut
        ? await window.opsdock.dispatch({ type: "rename-module-shortcut", shortcutId: shortcut.id, name })
        : active
          ? await window.opsdock.dispatch({ type: "add-module-shortcut", tabId: active.id, name })
          : null;
      if (result?.ok) setEditor(false);
      else setError(result?.error ?? "当前页面无法保存快捷入口");
    } catch {
      setError("快捷入口保存失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={shortcut ? "重命名快捷入口" : "保存模块快捷入口"} onClose={() => !busy && setEditor(false)}>
      <div className="modal-body">
        <label className="text-field">
          <span>名称</span>
          <input autoFocus disabled={busy} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) void save();
          }} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-actions">
        <button className="secondary-button" disabled={busy} onClick={() => setEditor(false)}>取消</button>
        <button className="primary-button small" disabled={!name.trim() || busy} onClick={save}>
          {busy && <LoaderCircle className="spin" size={15} />}保存
        </button>
      </footer>
    </Modal>
  );
}

export function LoginCredentialsModal() {
  const setOpen = useRendererStore((state) => state.setLoginCredentialsOpen);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [configured, setConfigured] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.opsdock.getLoginCredentials().then((status) => {
      setConfigured(status.configured);
      setUsername(status.username ?? "");
    }).catch(() => {
      setReadFailed(true);
      setError("已保存的登录信息无法读取或解密，可重新保存或清除");
    });
  }, []);

  const save = async () => {
    if (!username.trim() || !password || busy) return;
    setBusy(true); setError(null);
    try {
      await window.opsdock.saveLoginCredentials({ username, password });
      setOpen(false);
    } catch {
      setError("保存失败，请检查系统钥匙串后重试");
    } finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true); setError(null);
    try {
      await window.opsdock.clearLoginCredentials();
      setReadFailed(false);
      setConfigured(false); setUsername(""); setPassword("");
    } catch { setError("清除失败，请重试"); }
    finally { setBusy(false); }
  };
  return <Modal title="记住账号密码" onClose={() => !busy && setOpen(false)}>
    <div className="modal-body">
      <label className="text-field"><span>RAM 账号</span><input autoFocus autoComplete="username" disabled={busy} value={username} onChange={(event) => setUsername(event.target.value)} /></label>
      <label className="text-field"><span>密码</span><input type="password" autoComplete="current-password" disabled={busy} value={password} placeholder={configured ? "已保存，输入新密码以更新" : undefined} onChange={(event) => setPassword(event.target.value)} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <footer className="modal-actions">
      {(configured || readFailed) && <button className="danger-button" disabled={busy} onClick={() => void clear()}>清除已保存账密</button>}
      <div className="toolbar-spacer" />
      <button className="secondary-button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
      <button className="primary-button small" disabled={!username.trim() || !password || busy} onClick={() => void save()}>{busy && <LoaderCircle className="spin" size={15} />}保存</button>
    </footer>
  </Modal>;
}

export function LogoutModal() {
  const setOpen = useRendererStore((state) => state.setLogoutConfirmOpen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.opsdock.logout();
      if (result.ok) setOpen(false);
      else setError(result.error);
    } catch {
      setError("退出登录未完成，部分会话数据可能已清除，请重试");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="退出 RAM 登录" onClose={() => !busy && setOpen(false)}>
      <div className="modal-body">
        <div className="confirmation-copy">
          <CircleAlert size={22} />
          <p>将关闭所有控制台标签并清除 CloudDock 的 Cookie 和站点数据。收藏、模块与地域配置会保留。</p>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-actions">
        <button data-modal-initial-focus className="secondary-button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
        <button className="danger-button" disabled={busy} onClick={logout}>
          {busy && <LoaderCircle className="spin" size={16} />}
          退出并清除会话
        </button>
      </footer>
    </Modal>
  );
}
