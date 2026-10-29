import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

const HOST = "127.0.0.1";
const STORAGE_COOKIE = "opsdock_fake_cookie=stored";
const STORAGE_KEY = "opsdock-fake-local-storage";
const DATABASE_NAME = "opsdock-fake-indexed-db";
const CACHE_NAME = "opsdock-fake-cache";
const SERVICE_WORKER_CACHE_NAME = "opsdock-fake-service-worker-cache";

type Schedule = (callback: () => void, delay: number) => void;

export interface FakeConsoleServer {
  baseUrl: string;
  close(): Promise<void>;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function layout(title: string, route: string, content: string, script = ""): string {
  return `<!doctype html>
<html lang="en" data-route="${escapeHtml(route)}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; color: #182230; background: #f7f8fa; }
      main { max-width: 920px; margin: 0 auto; padding: 28px; }
      h1 { margin: 0 0 8px; font-size: 24px; }
      p { line-height: 1.5; }
      nav, .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 20px 0; }
      a, button { font: inherit; }
      button, .button { display: inline-flex; min-height: 34px; align-items: center; border: 1px solid #9ca8b7; border-radius: 4px; padding: 0 12px; color: #182230; background: #fff; cursor: pointer; text-decoration: none; }
      output, pre { display: block; margin-top: 8px; padding: 10px; border: 1px solid #d6dce5; border-radius: 4px; background: #fff; white-space: pre-wrap; overflow-wrap: anywhere; }
      table { width: 100%; border-collapse: collapse; background: #fff; }
      th, td { border: 1px solid #d6dce5; padding: 8px; text-align: left; }
    </style>
  </head>
  <body>
    <main data-testid="fake-console-page">
      ${content}
    </main>
    ${script ? `<script>${script}</script>` : ""}
  </body>
</html>`;
}

function send(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function sendHtml(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  title: string,
  route: string,
  content: string,
  script = "",
): void {
  send(
    request,
    response,
    status,
    "text/html; charset=utf-8",
    layout(title, route, content, script),
  );
}

function consolePage(product: "ACK" | "Kafka" | "MSE" | "DMS" | "Codeup" | "SLS", url: URL): { content: string; script: string } {
  const productId = product.toLowerCase();
  const region = product === "DMS" || product === "Codeup" || product === "SLS"
    ? null
    : url.searchParams.get("region") ?? (product === "ACK" ? "cn-beijing" : "cn-shanghai");
  const localPopupPath =
    product === "ACK"
      ? "/kafka/details?region=cn-shanghai"
      : product === "Kafka"
        ? "/ack/details?region=cn-beijing"
        : product === "MSE"
          ? `https://mse.console.aliyun.com/#/InstanceList?region=${encodeURIComponent(region!)}`
          : product === "DMS"
            ? "https://dms.aliyun.com/"
            : product === "Codeup"
              ? "https://codeup.aliyun.com/"
              : "https://sls.console.aliyun.com/lognext/profile";
  const detailPath =
    product === "ACK"
      ? `/ack/details?region=${encodeURIComponent(region!)}`
      : product === "Kafka"
        ? `/kafka/details?region=${encodeURIComponent(region!)}`
        : product === "MSE"
          ? `/mse/details?region=${encodeURIComponent(region!)}`
          : product === "DMS"
            ? "/dms/details"
            : product === "Codeup"
              ? "/codeup/details"
              : "/sls/details";
  const regionAttribute = region ? ` data-region="${escapeHtml(region)}"` : "";
  const regionRow = region
    ? `<tr><th>Region</th><td data-testid="console-region">${escapeHtml(region)}</td></tr>`
    : "";

  return {
    content: `
      <h1 data-testid="console-title">${product} fake console</h1>
      <p data-testid="console-ready" data-product="${productId}"${regionAttribute}>ready</p>
      <table>
        <tbody>
          <tr><th>Product</th><td data-testid="console-product">${product}</td></tr>
          ${regionRow}
          <tr><th>Path</th><td data-testid="console-path">${escapeHtml(url.pathname)}</td></tr>
        </tbody>
      </table>
      <nav aria-label="Fake console actions">
        <a class="button" data-testid="navigate-detail" href="${detailPath}">Open details</a>
        <button data-testid="open-console-popup" type="button">Open console popup</button>
        <button data-testid="open-help-popup" type="button">Open help popup</button>
        <a class="button" data-testid="download-attachment" href="/download">Download attachment</a>
        <a class="button" data-testid="open-storage-setup" href="/storage/setup">Set up storage</a>
        <a class="button" data-testid="open-permissions" href="/permissions">Permissions</a>
        <a class="button" data-testid="open-probes" href="/probes">Security probes</a>
      </nav>
      ${url.pathname === "/ack/find" ? `
        <p style="margin-top:800px" id="find-first">定位测试 first</p>
        <p style="margin-top:800px" id="find-second">定位测试 second</p>
        <p style="margin-top:800px" id="find-third">定位测试 third</p>
        <div style="height:800px"></div>
      ` : ""}`,
    script: `
      document.querySelector('[data-testid="open-console-popup"]').addEventListener('click', () => {
        window.open(${JSON.stringify(localPopupPath)}, '_blank', 'noopener=false');
      });
      document.querySelector('[data-testid="open-help-popup"]').addEventListener('click', () => {
        window.open('https://help.aliyun.com/document_detail/123.html', '_blank', 'noopener=false');
      });
    `,
  };
}

function popupPage(kind: "console" | "help"): { content: string; script: string } {
  const isConsole = kind === "console";
  const target = isConsole
    ? "/ack/details?region=cn-beijing"
    : "https://help.aliyun.com/document_detail/123.html";
  const testId = isConsole ? "open-console-popup" : "open-help-popup";

  return {
    content: `
      <h1>${isConsole ? "Console" : "Help"} popup fixture</h1>
      <p data-testid="popup-ready">ready</p>
      <button data-testid="${testId}" type="button">Open popup</button>`,
    script: `
      document.querySelector('[data-testid="${testId}"]').addEventListener('click', () => {
        window.open(${JSON.stringify(target)}, '_blank', 'noopener=false');
      });
    `,
  };
}

function storageSetupPage(): { content: string; script: string } {
  return {
    content: `
      <h1>Browser storage setup</h1>
      <p>Creates one value in every storage type used by the logout acceptance test.</p>
      <output data-testid="storage-status">pending</output>
      <pre data-testid="storage-result">{}</pre>`,
    script: `
      const storageStatus = document.querySelector('[data-testid="storage-status"]');
      const storageResult = document.querySelector('[data-testid="storage-result"]');

      function openDatabase() {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open(${JSON.stringify(DATABASE_NAME)}, 1);
          request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains('state')) database.createObjectStore('state');
          };
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
      }

      async function setUpStorage() {
        const result = {};
        document.cookie = ${JSON.stringify(`${STORAGE_COOKIE}; Path=/; SameSite=Lax`)};
        result.cookie = document.cookie.includes(${JSON.stringify(STORAGE_COOKIE)});

        localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, 'stored');
        result.localStorage = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});

        const database = await openDatabase();
        await new Promise((resolve, reject) => {
          const transaction = database.transaction('state', 'readwrite');
          transaction.objectStore('state').put('stored', 'marker');
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
        database.close();
        result.indexedDB = true;

        const cache = await caches.open(${JSON.stringify(CACHE_NAME)});
        await cache.put(
          new Request(location.origin + '/storage-cache-entry'),
          new Response('cached storage marker', { headers: { 'Content-Type': 'text/plain' } }),
        );
        result.cache = true;

        const registration = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
        await navigator.serviceWorker.ready;
        result.serviceWorker = Boolean(registration);

        window.fakeStorageSetup = result;
        document.documentElement.dataset.storageReady = 'true';
        storageStatus.textContent = 'ready';
        storageResult.textContent = JSON.stringify(result, null, 2);
      }

      setUpStorage().catch((error) => {
        const result = { error: error instanceof Error ? error.message : String(error) };
        window.fakeStorageSetup = result;
        document.documentElement.dataset.storageReady = 'false';
        storageStatus.textContent = 'error';
        storageResult.textContent = JSON.stringify(result, null, 2);
      });
    `,
  };
}

function storageInspectPage(): { content: string; script: string } {
  return {
    content: `
      <h1>Browser storage inspection</h1>
      <output data-testid="storage-inspection-status">pending</output>
      <pre data-testid="storage-inspection">{}</pre>`,
    script: `
      const inspectionStatus = document.querySelector('[data-testid="storage-inspection-status"]');
      const inspectionOutput = document.querySelector('[data-testid="storage-inspection"]');

      async function inspectStorage() {
        const databaseList = typeof indexedDB.databases === 'function'
          ? await indexedDB.databases()
          : [];
        const cacheNames = await caches.keys();
        const registrations = await navigator.serviceWorker.getRegistrations();
        const result = {
          cookie: document.cookie.includes(${JSON.stringify(STORAGE_COOKIE)}),
          localStorage: localStorage.getItem(${JSON.stringify(STORAGE_KEY)}),
          indexedDB: databaseList.some((database) => database.name === ${JSON.stringify(DATABASE_NAME)}),
          cache: cacheNames.includes(${JSON.stringify(CACHE_NAME)}),
          serviceWorkerCache: cacheNames.includes(${JSON.stringify(SERVICE_WORKER_CACHE_NAME)}),
          serviceWorker: registrations.some((registration) => registration.scope === location.origin + '/'),
        };
        window.fakeStorageInspection = result;
        document.documentElement.dataset.storageInspected = 'true';
        inspectionStatus.textContent = 'ready';
        inspectionOutput.textContent = JSON.stringify(result, null, 2);
      }

      inspectStorage().catch((error) => {
        const result = { error: error instanceof Error ? error.message : String(error) };
        window.fakeStorageInspection = result;
        document.documentElement.dataset.storageInspected = 'false';
        inspectionStatus.textContent = 'error';
        inspectionOutput.textContent = JSON.stringify(result, null, 2);
      });
    `,
  };
}

function permissionPage(): { content: string; script: string } {
  const permissionNames = [
    "geolocation",
    "notifications",
    "camera",
    "microphone",
    "display",
    "clipboard-read",
    "clipboard-write",
    "midi",
    "hid",
    "serial",
    "usb",
    "bluetooth",
  ];
  const controls = permissionNames
    .map(
      (name) => `
        <tr>
          <td>${name}</td>
          <td><button type="button" data-testid="permission-${name}" data-permission="${name}">Request</button></td>
          <td><output data-testid="permission-result-${name}">idle</output></td>
        </tr>`,
    )
    .join("");

  return {
    content: `
      <h1>Permission request fixtures</h1>
      <p data-testid="permissions-ready">ready</p>
      <table>
        <thead><tr><th>Permission</th><th>Action</th><th>Result</th></tr></thead>
        <tbody>${controls}</tbody>
      </table>`,
    script: `
      window.fakePermissionResults = {};

      function geolocationRequest() {
        return new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 1500 });
        });
      }

      async function mediaRequest(constraints) {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        stream.getTracks().forEach((track) => track.stop());
      }

      const requests = {
        geolocation: geolocationRequest,
        notifications: () => Notification.requestPermission().then((value) => {
          if (value !== 'granted') throw new DOMException(value, 'NotAllowedError');
        }),
        camera: () => mediaRequest({ video: true }),
        microphone: () => mediaRequest({ audio: true }),
        display: async () => {
          const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
          stream.getTracks().forEach((track) => track.stop());
        },
        'clipboard-read': () => navigator.clipboard.readText(),
        'clipboard-write': () => navigator.clipboard.writeText('opsdock fake clipboard value'),
        midi: () => navigator.requestMIDIAccess({ sysex: true }),
        hid: () => navigator.hid.requestDevice({ filters: [] }),
        serial: () => navigator.serial.requestPort(),
        usb: () => navigator.usb.requestDevice({ filters: [] }),
        bluetooth: () => navigator.bluetooth.requestDevice({ acceptAllDevices: true }),
      };

      document.querySelectorAll('[data-permission]').forEach((button) => {
        button.addEventListener('click', async () => {
          const name = button.dataset.permission;
          const output = document.querySelector('[data-testid="permission-result-' + name + '"]');
          output.textContent = 'pending';
          try {
            await requests[name]();
            window.fakePermissionResults[name] = { status: 'granted' };
            output.textContent = 'granted';
          } catch (error) {
            const result = {
              status: 'denied',
              name: error && error.name ? error.name : 'Error',
              message: error && error.message ? error.message : String(error),
            };
            window.fakePermissionResults[name] = result;
            output.textContent = 'denied:' + result.name;
          }
        });
      });
    `,
  };
}

function probePage(): { content: string; script: string } {
  return {
    content: `
      <h1>Node and preload probes</h1>
      <p data-testid="probes-ready">ready</p>
      <pre data-testid="probe-results">{}</pre>`,
    script: `
      function exposed(name) {
        try {
          return typeof globalThis[name] !== 'undefined';
        } catch {
          return false;
        }
      }

      const probes = {
        process: exposed('process'),
        require: exposed('require'),
        module: exposed('module'),
        Buffer: exposed('Buffer'),
        electron: exposed('electron'),
        opsdockPreload: exposed('opsdock'),
        preloadMarker: exposed('__OPSDOCK_PRELOAD__'),
      };
      window.fakeSecurityProbes = probes;
      document.documentElement.dataset.probesReady = 'true';
      document.querySelector('[data-testid="probe-results"]').textContent = JSON.stringify(probes, null, 2);
    `,
  };
}

function serviceWorkerSource(): string {
  return `
    const CACHE_NAME = ${JSON.stringify(SERVICE_WORKER_CACHE_NAME)};
    self.addEventListener('install', (event) => {
      event.waitUntil(
        caches.open(CACHE_NAME)
          .then((cache) => cache.put('/service-worker-marker', new Response('service worker marker')))
          .then(() => self.skipWaiting()),
      );
    });
    self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
  `;
}

function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  schedule: Schedule,
): void {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? HOST}`);
  const { pathname } = url;

  if (pathname === "/ack/post-receipt") {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => sendHtml(request, response, 200, "Form receipt", pathname,
      `<pre id="receipt">${escapeHtml(JSON.stringify({ method: request.method, body, referrer: request.headers.referer, contentType: request.headers["content-type"] }))}</pre>`));
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    send(request, response, 405, "text/plain; charset=utf-8", "Method Not Allowed", {
      Allow: "GET, HEAD",
    });
    return;
  }

  if (pathname === "/favicon.ico") {
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end();
    return;
  }

  if (pathname === "/service-worker.js") {
    send(
      request,
      response,
      200,
      "text/javascript; charset=utf-8",
      serviceWorkerSource(),
      { "Service-Worker-Allowed": "/" },
    );
    return;
  }

  if (pathname === "/download" || pathname === "/download/attachment") {
    send(
      request,
      response,
      200,
      "text/plain; charset=utf-8",
      "CloudDock fake console attachment\n",
      { "Content-Disposition": 'attachment; filename="opsdock-test-download.txt"' },
    );
    return;
  }

  if (pathname === "/storage-cache-entry" || pathname === "/service-worker-marker") {
    send(request, response, 200, "text/plain; charset=utf-8", "network storage marker");
    return;
  }

  if (pathname === "/service-worker-controlled") {
    send(request, response, 200, "text/plain; charset=utf-8", "network-response");
    return;
  }

  if (pathname === "/network-error") {
    request.socket.destroy();
    return;
  }

  if (pathname === "/slow") {
    const requestedDelay = Number(url.searchParams.get("delay") ?? "1500");
    const delay = Number.isFinite(requestedDelay)
      ? Math.min(Math.max(Math.trunc(requestedDelay), 0), 10_000)
      : 1_500;
    schedule(() => {
      if (response.destroyed) return;
      sendHtml(
        request,
        response,
        200,
        "Slow fake console",
        pathname,
        `<h1>Slow page</h1><p data-testid="slow-ready" data-delay="${delay}">ready</p>`,
      );
    }, delay);
    return;
  }

  if (pathname === "/error") {
    sendHtml(
      request,
      response,
      500,
      "Fake console error",
      pathname,
      "<h1>Server error</h1><p data-testid=\"error-ready\">intentional HTTP 500</p>",
    );
    return;
  }

  if (pathname === "/storage/setup" || pathname === "/storage") {
    const page = storageSetupPage();
    sendHtml(request, response, 200, "Storage setup", pathname, page.content, page.script);
    return;
  }

  if (pathname === "/storage/inspect") {
    const page = storageInspectPage();
    sendHtml(request, response, 200, "Storage inspection", pathname, page.content, page.script);
    return;
  }

  if (pathname === "/permissions" || pathname === "/permission") {
    const page = permissionPage();
    sendHtml(request, response, 200, "Permission fixtures", pathname, page.content, page.script);
    return;
  }

  if (pathname === "/probes") {
    const page = probePage();
    sendHtml(request, response, 200, "Security probes", pathname, page.content, page.script);
    return;
  }

  if (pathname === "/popup/console") {
    const page = popupPage("console");
    sendHtml(request, response, 200, "Console popup", pathname, page.content, page.script);
    return;
  }

  if (pathname === "/popup/help") {
    const page = popupPage("help");
    sendHtml(request, response, 200, "Help popup", pathname, page.content, page.script);
    return;
  }

  if (pathname === "/ack" || pathname.startsWith("/ack/")) {
    const page = consolePage("ACK", url);
    sendHtml(request, response, 200, "ACK fake console", pathname, page.content, page.script);
    return;
  }

  if (pathname === "/kafka" || pathname.startsWith("/kafka/")) {
    const page = consolePage("Kafka", url);
    sendHtml(request, response, 200, "Kafka fake console", pathname, page.content, page.script);
    return;
  }

  if (pathname === "/mse" || pathname.startsWith("/mse/")) {
    const page = consolePage("MSE", url);
    sendHtml(request, response, 200, "MSE fake console", pathname, page.content, page.script);
    return;
  }

  if (pathname === "/dms" || pathname.startsWith("/dms/")) {
    const page = consolePage("DMS", url);
    sendHtml(request, response, 200, "DMS fake console", pathname, page.content, page.script);
    return;
  }

  if (pathname === "/codeup" || pathname.startsWith("/codeup/")) {
    const page = consolePage("Codeup", url);
    sendHtml(request, response, 200, "Codeup fake console", pathname, page.content, page.script);
    return;
  }

  if (pathname === "/sls" || pathname.startsWith("/sls/")) {
    const page = consolePage("SLS", url);
    sendHtml(request, response, 200, "SLS fake console", pathname, page.content, page.script);
    return;
  }

  if (pathname === "/") {
    sendHtml(
      request,
      response,
      200,
      "CloudDock fake console",
      pathname,
      `<h1>CloudDock fake console</h1>
       <p data-testid="server-ready">ready</p>
       <nav>
         <a class="button" href="/ack?region=cn-beijing">ACK</a>
         <a class="button" href="/kafka?region=cn-shanghai">Kafka</a>
         <a class="button" href="/mse?region=cn-beijing">MSE</a>
         <a class="button" href="/dms">DMS</a>
         <a class="button" href="/codeup">Codeup</a>
         <a class="button" href="/sls">SLS</a>
         <a class="button" href="/storage/setup">Storage</a>
         <a class="button" href="/permissions">Permissions</a>
         <a class="button" href="/probes">Probes</a>
       </nav>`,
    );
    return;
  }

  sendHtml(
    request,
    response,
    404,
    "Fake console not found",
    pathname,
    `<h1>Not found</h1><p data-testid="not-found">${escapeHtml(pathname)}</p>`,
  );
}

export async function startFakeConsole(): Promise<FakeConsoleServer> {
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const sockets = new Set<Socket>();
  const schedule: Schedule = (callback, delay) => {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      callback();
    }, delay);
    pendingTimers.add(timer);
  };
  const server = createServer((request, response) => {
    try {
      handleRequest(request, response, schedule);
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      send(request, response, 500, "text/plain; charset=utf-8", `Fake console failure: ${message}`);
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, HOST);
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://${HOST}:${address.port}`;
  let closePromise: Promise<void> | undefined;

  return {
    baseUrl,
    close() {
      if (closePromise) return closePromise;
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();

      closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        for (const socket of sockets) socket.destroy();
      });
      return closePromise;
    },
  };
}
