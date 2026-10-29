import { describe, expect, it } from "vitest";
import {
  isConsoleShortcut,
  matchConsoleShortcut,
  type ConsoleShortcutInput,
} from "../../src/shared/console-shortcut";

function input(overrides: Partial<ConsoleShortcutInput> = {}): ConsoleShortcutInput {
  return {
    type: "keyDown",
    key: "k",
    meta: true,
    control: false,
    alt: false,
    shift: false,
    ...overrides,
  };
}

describe("matchConsoleShortcut", () => {
  it("matches the supported macOS command shortcuts", () => {
    expect(matchConsoleShortcut(input())).toEqual({ type: "open-command-palette" });
    expect(matchConsoleShortcut(input({ key: "T" }))).toEqual({ type: "open-link-opener" });
    expect(matchConsoleShortcut(input({ key: "W" }))).toEqual({ type: "close-active-tab" });
    expect(matchConsoleShortcut(input({ key: "R" }))).toEqual({ type: "reload-active-tab" });
    expect(matchConsoleShortcut(input({ key: "F" }))).toEqual({ type: "open-page-find" });
    expect(matchConsoleShortcut(input({ key: "[" }))).toEqual({ type: "navigate-back" });
    expect(matchConsoleShortcut(input({ key: "]" }))).toEqual({ type: "navigate-forward" });
    expect(matchConsoleShortcut(input({ key: "D" }))).toEqual({ type: "toggle-active-favorite" });
    expect(matchConsoleShortcut(input({ key: "T", shift: true }))).toEqual({ type: "reopen-closed-tab" });
    expect(matchConsoleShortcut(input({ key: "1" }))).toEqual({
      type: "activate-tab",
      position: 1,
    });
    expect(matchConsoleShortcut(input({ key: "9" }))).toEqual({
      type: "activate-tab",
      position: 9,
    });
  });

  it("matches forward and backward Control+Tab without Command", () => {
    expect(matchConsoleShortcut(input({
      key: "Tab",
      meta: false,
      control: true,
    }))).toEqual({ type: "activate-next-tab" });
    expect(matchConsoleShortcut(input({
      key: "Tab",
      meta: false,
      control: true,
      shift: true,
    }))).toEqual({ type: "activate-previous-tab" });
  });

  it("rejects key-up events, extra modifiers, and near misses", () => {
    expect(matchConsoleShortcut(input({ type: "keyUp" }))).toBeNull();
    expect(matchConsoleShortcut(input({ control: true }))).toBeNull();
    expect(matchConsoleShortcut(input({ alt: true }))).toBeNull();
    expect(matchConsoleShortcut(input({ meta: false }))).toBeNull();
    expect(matchConsoleShortcut(input({ key: "k", shift: true }))).toBeNull();
    expect(matchConsoleShortcut(input({ key: "w", shift: true }))).toBeNull();
    expect(matchConsoleShortcut(input({ key: "r", shift: true }))).toBeNull();
    expect(matchConsoleShortcut(input({ key: "f", shift: true }))).toBeNull();
    expect(matchConsoleShortcut(input({ key: "[", shift: true }))).toBeNull();
    expect(matchConsoleShortcut(input({ key: "]", control: true }))).toBeNull();
    expect(matchConsoleShortcut(input({ key: "d", shift: true }))).toBeNull();
    expect(matchConsoleShortcut(input({ key: "t", control: true }))).toBeNull();
    expect(matchConsoleShortcut(input({ key: "1", control: true }))).toBeNull();
    expect(matchConsoleShortcut(input({ key: "1", shift: true }))).toBeNull();
    expect(matchConsoleShortcut(input({ key: "Tab", meta: false }))).toBeNull();
    expect(matchConsoleShortcut(input({ key: "Tab", meta: true, control: true }))).toBeNull();
    expect(matchConsoleShortcut(input({
      key: "Tab",
      meta: false,
      control: true,
      alt: true,
    }))).toBeNull();
  });

  it("validates forwarded shortcut payloads", () => {
    expect(isConsoleShortcut({ type: "activate-next-tab" })).toBe(true);
    expect(isConsoleShortcut({ type: "navigate-back" })).toBe(true);
    expect(isConsoleShortcut({ type: "navigate-forward" })).toBe(true);
    expect(isConsoleShortcut({ type: "open-page-find" })).toBe(true);
    expect(isConsoleShortcut({ type: "toggle-active-favorite" })).toBe(true);
    expect(isConsoleShortcut({ type: "activate-tab", position: 9 })).toBe(true);
    expect(isConsoleShortcut({ type: "activate-tab", position: 0 })).toBe(false);
    expect(isConsoleShortcut({ type: "activate-tab", position: 10 })).toBe(false);
    expect(isConsoleShortcut({ type: "activate-tab", position: "1" })).toBe(false);
    expect(isConsoleShortcut({ type: "activate-tab", position: 1, extra: true })).toBe(false);
    expect(isConsoleShortcut({ type: "activate-next-tab", position: 1 })).toBe(false);
    expect(isConsoleShortcut({ type: "unknown" })).toBe(false);
    expect(isConsoleShortcut("activate-next-tab")).toBe(false);
  });
});
