// src/preview-sw.js — Service Worker for preview routing.
//
// Intercepts `/__virtual__/{port}/*` requests and routes them to guest
// servers running in CodeSandbox iframes. This makes guest servers real
// navigable URLs (address bar, iframes, new tabs) — patching `fetch` only
// covers programmatic JS requests.
//
// Architecture:
//   browser navigation → SW fetch handler → postMessage to host page →
//   host forwards to sandbox via __httpServerRunTime.handleRequest →
//   response bubbles back through the same channel.
//
// The SW is opt-in: the host must call `registerPreviewSW()` explicitly.
// It never auto-registers (page-wide side effects).
//
// Limitations (honest):
// - Requires HTTPS or localhost (Service Worker spec requirement).
// - First-load race: the SW takes control on second navigation; the host
//   should call `clients.claim()` or reload after registration.
// - Streaming bodies: supported via ReadableStream where the sandbox
//   returns chunks; falls back to buffered.

const VIRTUAL_PREFIX = "/__virtual__/";

// Parse /__virtual__/{port}/path → {port, path} or null.
function parseVirtualUrl(url) {
  try {
    const u = new URL(url);
    if (!u.pathname.startsWith(VIRTUAL_PREFIX)) return null;
    const rest = u.pathname.slice(VIRTUAL_PREFIX.length);
    const slashIdx = rest.indexOf("/");
    const portStr = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    const path = slashIdx === -1 ? "/" : rest.slice(slashIdx);
    const port = parseInt(portStr, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { port, path: path + u.search, portStr };
  } catch {
    return null;
  }
}

// Ask the host page to route this request to the sandbox.
// Returns a Promise<Response>.
function routeToSandbox(port, path, request) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeoutId = setTimeout(() => {
      reject(new Error(`Preview routing timeout for port ${port}`));
    }, 30000);

    channel.port1.onmessage = (event) => {
      clearTimeout(timeoutId);
      const { status, headers, body } = event.data;
      if (event.data.error) {
        reject(new Error(event.data.error));
        return;
      }
      resolve(
        new Response(body, {
          status: status || 200,
          headers: headers || {},
        }),
      );
    };

    // Collect request body for POST/PUT/PATCH.
    const sendRequest = (bodyBuffer) => {
      // Find the host client (the page that registered us).
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clients) => {
          if (clients.length === 0) {
            clearTimeout(timeoutId);
            reject(new Error("No host page found for preview routing"));
            return;
          }
          // Prefer the focused client, else the first.
          const client =
            clients.find((c) => c.focused) || clients[0];
          client.postMessage(
            {
              type: "__BVM_PREVIEW_REQUEST__",
              port,
              path,
              method: request.method,
              headers: Object.fromEntries(request.headers.entries()),
              body: bodyBuffer,
            },
            [channel.port2],
          );
        });
    };

    if (request.method === "GET" || request.method === "HEAD") {
      sendRequest(null);
    } else {
      request
        .arrayBuffer()
        .then((buf) => sendRequest(buf))
        .catch((err) => {
          clearTimeout(timeoutId);
          reject(err);
        });
    }
  });
}

self.addEventListener("fetch", (event) => {
  const parsed = parseVirtualUrl(event.request.url);
  if (!parsed) return; // not ours — let it through

  event.respondWith(
    routeToSandbox(parsed.port, parsed.path, event.request).catch(
      (err) => {
        // 502 with a clear message — never hang.
        return new Response(
          `Preview routing failed for port ${parsed.port}: ${err.message}`,
          {
            status: 502,
            headers: { "Content-Type": "text/plain" },
          },
        );
      },
    ),
  );
});

// Take control immediately on install (host should still handle the
// first-load race by reloading or waiting for controllerchange).
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
