import { X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

interface ModalProps {
  title: string;
  children: React.ReactNode;
  className?: string;
  onClose?: () => void;
  width?: number;
}

export function Modal({ title, children, className, onClose, width = 460 }: ModalProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const previouslyFocusedRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const getFocusableElements = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog) return [];
    return Array.from(dialog.querySelectorAll<HTMLElement>("*")).filter((element) =>
      element.matches('button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')
      && !element.hasAttribute("hidden")
      && !element.matches(":disabled"));
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (event.key === "Escape" && onCloseRef.current) {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = getFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const initialFocus = dialog.querySelector<HTMLElement>("[data-modal-initial-focus]")
      ?? dialog.querySelector<HTMLElement>("[autofocus]")
      ?? getFocusableElements()[0]
      ?? dialog;

    if (!dialog.contains(document.activeElement)) initialFocus.focus();
    return () => {
      const previouslyFocused = previouslyFocusedRef.current;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [getFocusableElements]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose?.();
    }}>
      <section ref={dialogRef} className={`modal ${className ?? ""}`.trim()} style={{ width }} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={handleKeyDown}>
        <header className="modal-header">
          <h2>{title}</h2>
          {onClose && (
            <button className="icon-button" onClick={onClose} aria-label="关闭" title="关闭">
              <X size={17} />
            </button>
          )}
        </header>
        {children}
      </section>
    </div>
  );
}
