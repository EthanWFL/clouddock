export const SIMPLE_CONSOLE_SHORTCUTS = [
  "open-command-palette",
  "open-link-opener",
  "close-active-tab",
  "reopen-closed-tab",
  "activate-next-tab",
  "activate-previous-tab",
  "reload-active-tab",
  "open-page-find",
  "navigate-back",
  "navigate-forward",
  "toggle-active-favorite",
] as const;
export const TAB_SHORTCUT_POSITIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export type SimpleConsoleShortcut = (typeof SIMPLE_CONSOLE_SHORTCUTS)[number];
export type TabShortcutPosition = (typeof TAB_SHORTCUT_POSITIONS)[number];
export type ConsoleShortcut =
  | { type: SimpleConsoleShortcut }
  | { type: "activate-tab"; position: TabShortcutPosition };

export function isConsoleShortcut(input: unknown): input is ConsoleShortcut {
  if (typeof input !== "object" || input === null || !("type" in input)) return false;
  const candidate = input as { type?: unknown; position?: unknown };
  const keys = Object.keys(input);
  if (candidate.type === "activate-tab") {
    return keys.length === 2
      && keys.includes("position")
      && TAB_SHORTCUT_POSITIONS.some((position) => position === candidate.position);
  }
  return keys.length === 1
    && SIMPLE_CONSOLE_SHORTCUTS.some((type) => type === candidate.type);
}

export interface ConsoleShortcutInput {
  type: string;
  key: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

export function matchConsoleShortcut(input: ConsoleShortcutInput): ConsoleShortcut | null {
  if (input.type !== "keyDown" || input.alt) return null;

  const key = input.key.toLowerCase();
  if (input.meta && !input.control) {
    if (!input.shift && key === "k") return { type: "open-command-palette" };
    if (!input.shift && key === "t") return { type: "open-link-opener" };
    if (!input.shift && key === "w") return { type: "close-active-tab" };
    if (!input.shift && key === "r") return { type: "reload-active-tab" };
    if (!input.shift && key === "f") return { type: "open-page-find" };
    if (!input.shift && key === "[") return { type: "navigate-back" };
    if (!input.shift && key === "]") return { type: "navigate-forward" };
    if (!input.shift && key === "d") return { type: "toggle-active-favorite" };
    if (input.shift && key === "t") return { type: "reopen-closed-tab" };
    if (!input.shift && /^[1-9]$/.test(key)) {
      return { type: "activate-tab", position: Number(key) as TabShortcutPosition };
    }
    return null;
  }

  if (!input.meta && input.control && key === "tab") {
    return { type: input.shift ? "activate-previous-tab" : "activate-next-tab" };
  }
  return null;
}
