import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_RENDERER_URL,
  resolveRendererAssetPath,
  selectRendererUrl,
} from "../../src/main/modules/app-protocol/app-protocol";

const rendererRoot = resolve("out/renderer");

describe("app protocol renderer path policy", () => {
  it("ignores development renderer overrides in packaged builds", () => {
    expect(selectRendererUrl(true, "https://attacker.example/shell")).toBe(
      APP_RENDERER_URL,
    );
    expect(selectRendererUrl(false, "http://localhost:5173")).toBe(
      "http://localhost:5173",
    );
    expect(selectRendererUrl(false, undefined)).toBe(APP_RENDERER_URL);
  });

  it("maps the renderer document and nested assets inside the renderer root", () => {
    expect(resolveRendererAssetPath(rendererRoot, APP_RENDERER_URL)).toBe(
      resolve(rendererRoot, "index.html"),
    );
    expect(
      resolveRendererAssetPath(
        rendererRoot,
        "app://renderer/assets/index-CzURTm4w.js?cache=1",
      ),
    ).toBe(resolve(rendererRoot, "assets/index-CzURTm4w.js"));
    expect(resolveRendererAssetPath(rendererRoot, "app://renderer/")).toBe(
      resolve(rendererRoot, "index.html"),
    );
  });

  it("rejects other origins, credentials, ports, and malformed URLs", () => {
    expect(resolveRendererAssetPath(rendererRoot, "https://renderer/index.html")).toBeNull();
    expect(resolveRendererAssetPath(rendererRoot, "app://other/index.html")).toBeNull();
    expect(resolveRendererAssetPath(rendererRoot, "app://user@renderer/index.html")).toBeNull();
    expect(resolveRendererAssetPath(rendererRoot, "app://renderer:42/index.html")).toBeNull();
    expect(resolveRendererAssetPath(rendererRoot, "not a URL")).toBeNull();
  });

  it("rejects path traversal and encoded path separators", () => {
    expect(resolveRendererAssetPath(rendererRoot, "app://renderer/../main/index.js")).toBeNull();
    expect(resolveRendererAssetPath(rendererRoot, "app://renderer/%2e%2e/main/index.js")).toBeNull();
    expect(resolveRendererAssetPath(rendererRoot, "app://renderer/assets/%2fetc/passwd")).toBeNull();
    expect(resolveRendererAssetPath(rendererRoot, "app://renderer/assets/%5c..%5cmain.js")).toBeNull();
    expect(resolveRendererAssetPath(rendererRoot, "app://renderer//etc/passwd")).toBeNull();
    expect(resolveRendererAssetPath(rendererRoot, "app://renderer/%00secret")).toBeNull();
  });
});
