import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

export function PageFindBar({
  inputRef,
  value,
  activeMatchOrdinal,
  matches,
  searching,
  onChange,
  onFind,
  onClose,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  activeMatchOrdinal: number;
  matches: number;
  searching: boolean;
  onChange: (value: string) => void;
  onFind: (forward: boolean) => void;
  onClose: () => void;
}) {
  const count = !value ? "" : searching ? "查找中" : matches > 0 ? `${activeMatchOrdinal} / ${matches}` : "无结果";
  return (
    <div className="page-find-row">
      <div className="page-find-bar" role="search" aria-label="页内查找">
        <Search size={14} aria-hidden="true" />
        <input
          ref={inputRef}
          aria-label="查找内容"
          aria-keyshortcuts="Meta+F"
          maxLength={500}
          placeholder="在当前页面中查找"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              onFind(!event.shiftKey);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <span className={`page-find-count ${value && matches === 0 && !searching ? "empty" : ""}`.trim()} role="status">
          {count}
        </span>
        <button type="button" aria-label="上一个匹配项" title="上一个匹配项" disabled={!value || matches === 0} onClick={() => onFind(false)}>
          <ChevronUp size={15} />
        </button>
        <button type="button" aria-label="下一个匹配项" title="下一个匹配项" disabled={!value || matches === 0} onClick={() => onFind(true)}>
          <ChevronDown size={15} />
        </button>
        <button type="button" aria-label="关闭页内查找" title="关闭页内查找" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
