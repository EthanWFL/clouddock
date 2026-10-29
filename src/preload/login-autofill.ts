import { ipcRenderer } from "electron";
import { isAllowedAuthHost } from "../shared/navigation-policy";
import { REMOTE_CREDENTIALS_FILL_CHANNEL } from "../shared/remote-ipc";

const USERNAME_SELECTORS = [
  'input[autocomplete="username"]',
  'input[name="username"]',
  'input[name="userName"]',
  'input[name="loginName"]',
  'input[id="username"]',
  'input[id="loginName"]',
  'input[placeholder*="用户名"]',
  'input[placeholder*="账号"]',
];
const PASSWORD_SELECTORS = [
  'input[autocomplete="current-password"]',
  'input[name="password"]',
  'input[name="loginPassword"]',
  'input[id="password"]',
  'input[id="loginPassword"]',
  'input[type="password"]',
];
const OBSERVE_TIMEOUT_MS = 60_000;

interface LoginCredentials {
  username: string;
  password: string;
}

let observer: MutationObserver | null = null;
let timeout: ReturnType<typeof setTimeout> | null = null;
let pending: LoginCredentials | null = null;

function stop(): void {
  observer?.disconnect();
  observer = null;
  if (timeout) clearTimeout(timeout);
  timeout = null;
  pending = null;
}

function isVisibleInput(input: HTMLInputElement): boolean {
  if (input.disabled || input.readOnly || input.type === "hidden") return false;
  const style = getComputedStyle(input);
  return style.display !== "none"
    && style.visibility !== "hidden"
    && style.opacity !== "0"
    && input.getAttribute("aria-hidden") !== "true"
    && input.getClientRects().length > 0;
}

function findInput(selectors: readonly string[]): HTMLInputElement | null {
  for (const selector of selectors) {
    for (const input of document.querySelectorAll<HTMLInputElement>(selector)) {
      if (isVisibleInput(input)) return input;
    }
  }
  return null;
}

function setInputValue(input: HTMLInputElement | null, value: string): void {
  if (!input || input.value) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) return;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function fill(): void {
  if (!pending) return;
  const username = findInput(USERNAME_SELECTORS);
  const password = findInput(PASSWORD_SELECTORS);
  setInputValue(username, pending.username);
  setInputValue(password, pending.password);
  if (password?.value) stop();
}

ipcRenderer.on(REMOTE_CREDENTIALS_FILL_CHANNEL, (_event, input: unknown) => {
  if (
    location.protocol !== "https:"
    || !isAllowedAuthHost(location.hostname)
    || typeof input !== "object"
    || input === null
    || !("username" in input)
    || !("password" in input)
    || typeof input.username !== "string"
    || typeof input.password !== "string"
    || !input.username
    || !input.password
  ) return;

  stop();
  pending = { username: input.username, password: input.password };
  fill();
  if (!pending) return;
  observer = new MutationObserver(fill);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["aria-hidden", "class", "disabled", "hidden", "readonly", "style"],
    childList: true,
    subtree: true,
  });
  timeout = setTimeout(stop, OBSERVE_TIMEOUT_MS);
});

window.addEventListener("pagehide", stop);
