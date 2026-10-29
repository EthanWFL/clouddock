import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = join(root, "chrome-extension");
const manifest = JSON.parse(await readFile(join(extensionRoot, "manifest.json"), "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(manifest.manifest_version === 3, "Chrome extension must use Manifest V3");
assert(!manifest.host_permissions, "Chrome extension must not request host permissions");
assert(!manifest.content_scripts, "Chrome extension must not inject content scripts");
assert(
  JSON.stringify([...manifest.permissions].sort()) === JSON.stringify(["activeTab", "contextMenus", "storage"]),
  "Chrome extension permissions must remain minimal",
);

const sourceFiles = ["background.js", "rules.js", "popup.js", "options.js"];
const requiredFiles = [
  ...sourceFiles,
  "popup.html",
  "options.html",
  "styles.css",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
];

for (const relativePath of requiredFiles) {
  const details = await stat(join(extensionRoot, relativePath));
  assert(details.isFile() && details.size > 0, `Missing extension file: ${relativePath}`);
}
for (const relativePath of sourceFiles) {
  const result = spawnSync(process.execPath, ["--check", join(extensionRoot, relativePath)], { stdio: "inherit" });
  assert(result.status === 0, `Invalid JavaScript: ${relativePath}`);
}

for (const size of [16, 32, 48, 128]) {
  const png = await readFile(join(extensionRoot, `icons/icon${size}.png`));
  assert(png.toString("ascii", 1, 4) === "PNG", `Invalid PNG icon${size}.png`);
  assert(png.readUInt32BE(16) === size && png.readUInt32BE(20) === size, `Wrong icon${size}.png dimensions`);
}

console.log("CloudDock Chrome MV3 extension validation passed");
