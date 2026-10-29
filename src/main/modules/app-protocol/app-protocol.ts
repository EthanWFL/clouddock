import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";

export const APP_PROTOCOL_SCHEME = "app";
export const APP_PROTOCOL_HOST = "renderer";
export const APP_RENDERER_URL = `${APP_PROTOCOL_SCHEME}://${APP_PROTOCOL_HOST}/index.html`;

export function selectRendererUrl(
  isPackaged: boolean,
  developmentUrl: string | undefined,
): string {
  return !isPackaged && developmentUrl ? developmentUrl : APP_RENDERER_URL;
}

export const APP_PROTOCOL_REGISTRATION: Electron.CustomScheme = {
  scheme: APP_PROTOCOL_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    codeCache: true,
  },
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function rawPathname(urlValue: string): string | null {
  const schemePrefix = `${APP_PROTOCOL_SCHEME}://`;
  if (!urlValue.toLowerCase().startsWith(schemePrefix)) return null;
  const afterScheme = urlValue.slice(schemePrefix.length);
  const pathIndex = afterScheme.indexOf("/");
  if (pathIndex === -1) return "/";
  return afterScheme.slice(pathIndex).split(/[?#]/, 1)[0];
}

export function resolveRendererAssetPath(
  rendererRoot: string,
  urlValue: string,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== `${APP_PROTOCOL_SCHEME}:`
    || parsed.hostname !== APP_PROTOCOL_HOST
    || parsed.username
    || parsed.password
    || parsed.port
  ) {
    return null;
  }

  const rawPath = rawPathname(urlValue);
  if (!rawPath || rawPath.startsWith("//")) return null;

  const rawSegments = rawPath.split("/").slice(1);
  const segments: string[] = [];
  for (const rawSegment of rawSegments) {
    if (!rawSegment) continue;
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (
      segment === "."
      || segment === ".."
      || segment.includes("/")
      || segment.includes("\\")
      || segment.includes("\0")
    ) {
      return null;
    }
    segments.push(segment);
  }

  if (segments.length === 0) segments.push("index.html");
  const root = resolve(rendererRoot);
  const candidate = resolve(root, ...segments);
  const childPath = relative(root, candidate);
  if (
    childPath === ".."
    || childPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    || isAbsolute(childPath)
  ) {
    return null;
  }
  return candidate;
}

function contentType(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function protocolError(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function installAppProtocol(
  protocolInstance: Pick<Electron.Protocol, "handle">,
  rendererRoot: string,
): void {
  protocolInstance.handle(APP_PROTOCOL_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const filePath = resolveRendererAssetPath(rendererRoot, request.url);
    if (!filePath) return protocolError(404);

    try {
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) return protocolError(404);
      const body = request.method === "HEAD" ? null : await readFile(filePath);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": contentType(filePath),
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return protocolError(404);
    }
  });
}
