import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { synchronizeAppearance } from "./appearance";
import "./styles.css";
import type { AppAppearance } from "../../shared/api";

document.documentElement.dataset.platform = navigator.platform.startsWith("Mac") ? "darwin" : "other";
document.documentElement.dataset.theme = window.matchMedia("(prefers-color-scheme: dark)").matches
  ? "dark"
  : "light";

function applyAppearance(appearance: AppAppearance): void {
  document.documentElement.dataset.theme = appearance.colorScheme;
  if (appearance.accentColor) {
    document.documentElement.style.setProperty("--system-accent", appearance.accentColor);
  } else {
    document.documentElement.style.removeProperty("--system-accent");
  }
}

const unsubscribeAppearance = synchronizeAppearance(window.opsdock, applyAppearance);
window.addEventListener("pagehide", unsubscribeAppearance, { once: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
