// src/plugins/preview-routing.js — preview routing for guest HTTP servers.
//
// A Service Worker intercepts `/__virtual__/{port}/*` and routes each
// request to the guest server listening on that port inside a sandbox,
// through the public `sandbox.invoke("__serverRequest__", …)` bridge
// (the same interop the host fetch patch uses). This makes guest servers
// real navigable URLs: address-bar navigation, iframes, and new-tab
// previews — things the fetch patch (programmatic JS requests only) can
// never cover.
//
// Layering (deliberate):
//   - `src/preview-sw.js` is a thin transport: match URL, read body,
//     postMessage to a client, await the reply, build a Response. It does
//     NOT validate ports or own routing state.
//   - THIS module is the authority: URL parsing, the port→handler
//     registry, body normalization, and error mapping. All of it is unit
//     tested here; the SW just forwards.
//
// Opt-in by design: nothing in this module runs at import time. The host
// calls `registerPreviewSW()` explicitly — SW registration has page-wide
// side effects and must never auto-activate. `trackSandbox(sandbox)` wires
// a CodeSandbox's `execution:server` events into the route registry.
//
// Message protocol (SW ↔ host page):
//   SW → host:  { type: "bvm:preview-request", id, port, method,
//                 pathname, search, headers, body }
//               body is an ArrayBuffer (transferred) or null.
//   host → SW:  { type: "bvm:preview-response", id, ok: true,
//                 result: { statusCode, statusMessage, headers, body } }
//               or { type: "bvm:preview-response", id, ok: false,
//                 error: { code, message } }.

export const PREVIEW_SCOPE = "/__virtual__/";
export const PREVIEW_SW_URL = "/__virtual__/preview-sw.js";

// How long the SW waits for the host page to answer before giving up.
// The host never hangs: a missing route answers immediately; a dead
// sandbox's invoke rejects and unregisters the route.
export const PREVIEW_REQUEST_TIMEOUT_MS = 20000;

// ─── URL parsing (authority; unit-tested) ───────────────────────────────

/**
 * Parse a same-origin pathname into `{ port, path }`, or null when it is
 * not a preview URL. `path` always starts with "/" ("/" for bare port).
 */
export function parsePreviewUrl(pathname) {
  if (typeof pathname !== "string") return null;
  const m = /^\/__virtual__\/(\d+)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { port, path: m[2] || "/" };
}

// ─── Route registry (port → handler; first claim wins) ──────────────────

const previewRoutes = new Map();

/**
 * Register a handler for a guest port. Returns false (first claim wins)
 * when the port is already taken or the arguments are invalid.
 * handler: async ({ method, path, headers, body }) => result
 *   result: { statusCode, statusMessage, headers, body }
 */
export function registerPreviewRoute(port, handler) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (typeof handler !== "function") return false;
  if (previewRoutes.has(port)) return false;
  previewRoutes.set(port, handler);
  return true;
}

export function unregisterPreviewRoute(port) {
  return previewRoutes.delete(port);
}

export function lookupPreviewRoute(port) {
  return previewRoutes.get(port);
}

export function clearPreviewRoutes() {
  previewRoutes.clear();
}

// ─── Body normalization ─────────────────────────────────────────────────

/**
 * Normalize a handler result body to an ArrayBuffer (transferable to the
 * SW) or null. Strings are UTF-8 encoded; Uint8Array views are copied so
 * the transfer never aliases a pooled buffer.
 */
export function normalizePreviewBody(body) {
  if (body == null) return null;
  if (body instanceof ArrayBuffer) return body;
  if (typeof body === "string") return new TextEncoder().encode(body).buffer;
  if (ArrayBuffer.isView(body)) {
    const copy = new Uint8Array(body.byteLength);
    copy.set(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );
    return copy.buffer;
  }
  return new TextEncoder().encode(String(body)).buffer;
}

// ─── Error pages (the forwardPreviewErrors pattern) ─────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build an HTML error page for a failed preview request. A readable page
 * beats a blank tab: it says what happened and how to fix it.
 */
export function buildPreviewErrorHtml(status, message, port) {
  const hint =
    port != null
      ? `<p>No guest server is listening on port ${port}. Start one in the sandbox, e.g. <code>http.createServer((req, res) =&gt; res.end("hi")).listen(${port})</code>.</p>`
      : "";
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>Preview error ${status}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:60ch;margin:4rem auto;padding:0 1rem">` +
    `<h1>Preview error ${status}</h1>` +
    `<p>${escapeHtml(message)}</p>${hint}</body></html>`
  );
}

// ─── SW message protocol helpers ─────────────────────────────────────────

export function previewRequestMessage({
  id,
  port,
  method,
  pathname,
  search,
  headers,
  body,
}) {
  return {
    type: "bvm:preview-request",
    id,
    port,
    method,
    pathname,
    search,
    headers,
    body: body ?? null,
  };
}

export function isPreviewRequest(msg) {
  return (
    !!msg &&
    typeof msg === "object" &&
    msg.type === "bvm:preview-request" &&
    typeof msg.id === "string"
  );
}

export function isPreviewResponse(msg) {
  return (
    !!msg &&
    typeof msg === "object" &&
    msg.type === "bvm:preview-response" &&
    typeof msg.id === "string"
  );
}

// ─── Sandbox tracking ────────────────────────────────────────────────────

/**
 * Wire a CodeSandbox's `execution:server` open/close events into the
 * preview route registry. The handler uses the public
 * `sandbox.invoke("__serverRequest__", port, path, method, body, headers)`
 * bridge — the same call shape as the host fetch patch
 * (`_vfsDispatchToSandbox` in runtime.js).
 *
 * Returns an untrack function that removes this sandbox's routes.
 */
export function trackSandbox(sandbox) {
  const owned = new Map(); // port -> handler
  const onServer = (evt) => {
    const port = Number(evt && evt.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    if (evt.type === "open") {
      const handler = async ({ method, path, headers, body }) =>
        sandbox.invoke(
          "__serverRequest__",
          port,
          path,
          method,
          body === null ? {} : body,
          headers,
        );
      if (registerPreviewRoute(port, handler)) owned.set(port, handler);
    } else if (evt.type === "closed") {
      if (owned.get(port) === lookupPreviewRoute(port)) {
        unregisterPreviewRoute(port);
      }
      owned.delete(port);
    }
  };
  sandbox.on("execution:server", onServer);
  return () => {
    for (const [port, handler] of owned) {
      if (lookupPreviewRoute(port) === handler) unregisterPreviewRoute(port);
    }
    owned.clear();
  };
}

// ─── Service Worker registration (explicit opt-in) ───────────────────────

/**
 * Wait until a ServiceWorkerRegistration has an active worker.
 * Do NOT use `navigator.serviceWorker.ready` here: it only resolves for
 * registrations whose scope covers the CURRENT page, and preview hosts
 * typically live outside `/__virtual__/` (ready would hang forever even
 * with a fully active worker — observed 2026-10-04).
 */
export function waitForSWActive(reg, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      if (reg.active) return resolve(reg.active);
      if (Date.now() - t0 > timeoutMs) {
        return reject(new Error("Timed out waiting for preview SW to activate"));
      }
      const sw = reg.installing || reg.waiting;
      if (sw) {
        const onChange = () => {
          if (sw.state === "activated" || sw.state === "redundant") {
            sw.removeEventListener("statechange", onChange);
            poll();
          }
        };
        sw.addEventListener("statechange", onChange);
        if (sw.state === "activated" || sw.state === "redundant") {
          sw.removeEventListener("statechange", onChange);
          poll();
          return;
        }
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

let bridgeInstalled = false;

/**
 * Answer one SW preview request. Runs on the host page; the SW is just
 * transport. Errors become `{ ok: false, error }` replies — the SW maps
 * them to 502/500 pages (never a hang).
 */
async function answerPreviewRequest(msg, source) {
  const reply = (payload, transfer) => {
    try {
      source.postMessage(
        { type: "bvm:preview-response", id: msg.id, ...payload },
        transfer || [],
      );
    } catch {
      /* client went away; nothing to do */
    }
  };
  const parsed = parsePreviewUrl(msg.pathname || "");
  if (!parsed) {
    reply({ ok: false, error: { code: "BAD_URL", message: "Not a preview URL" } });
    return;
  }
  const handler = lookupPreviewRoute(parsed.port);
  if (!handler) {
    reply({
      ok: false,
      error: {
        code: "NO_ROUTE",
        message: `No guest server listening on port ${parsed.port}`,
        port: parsed.port,
      },
    });
    return;
  }
  try {
    const result = await handler({
      method: msg.method || "GET",
      path: parsed.path + (msg.search || ""),
      headers: msg.headers || {},
      body: msg.body ?? null,
    });
    const bodyBuf = normalizePreviewBody(result && result.body);
    reply(
      {
        ok: true,
        result: {
          statusCode: (result && result.statusCode) || 200,
          statusMessage: (result && result.statusMessage) || "",
          headers: (result && result.headers) || {},
          body: bodyBuf,
        },
      },
      bodyBuf ? [bodyBuf] : [],
    );
  } catch (err) {
    // Owner died mid-flight: drop the stale route like the fetch bridge.
    unregisterPreviewRoute(parsed.port);
    reply({
      ok: false,
      error: {
        code: "HANDLER_ERROR",
        message: String((err && err.message) || err),
        port: parsed.port,
      },
    });
  }
}

function ensureMessageBridge() {
  if (bridgeInstalled) return;
  bridgeInstalled = true;
  navigator.serviceWorker.addEventListener("message", (event) => {
    const msg = event.data;
    if (!isPreviewRequest(msg)) return;
    // event.source is the ServiceWorker that sent the request.
    answerPreviewRequest(msg, event.source);
  });
}

/**
 * Register the preview Service Worker. Explicit opt-in: SW registration
 * has page-wide side effects (it intercepts `/__virtual__/*` for every
 * tab under the scope), so this module never calls it automatically.
 *
 * The SW script should be served at (or under) the scope, e.g.
 * `/__virtual__/preview-sw.js` with the default scope `/__virtual__/`,
 * so no `Service-Worker-Allowed` header is needed.
 *
 * Resolves with the ServiceWorkerRegistration once the worker is ACTIVE
 * (not merely registered — activation is awaited because preview iframes
 * need a live worker; see waitForSWActive for why `ready` is not used).
 */
export async function registerPreviewSW(
  swUrl = PREVIEW_SW_URL,
  opts = {},
) {
  if (
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  ) {
    throw new Error(
      "Preview routing requires navigator.serviceWorker (secure context: HTTPS or localhost)",
    );
  }
  const scope = opts.scope || PREVIEW_SCOPE;
  const reg = await navigator.serviceWorker.register(swUrl, { scope });
  await waitForSWActive(reg, opts.timeoutMs);
  ensureMessageBridge();
  return reg;
}

/**
 * Undo registerPreviewSW: unregister the SW and drop the message bridge.
 * Primarily for tests; production hosts rarely need it.
 */
export async function unregisterPreviewSW() {
  if (
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  ) {
    return false;
  }
  const reg = await navigator.serviceWorker.getRegistration(PREVIEW_SCOPE);
  bridgeInstalled = false;
  if (reg) return reg.unregister();
  return false;
}
