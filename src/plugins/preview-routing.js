// src/plugins/preview-routing.js — opt-in preview routing via Service Worker.
//
// Makes guest servers real navigable URLs: `/__virtual__/{port}/path`
// routes to the CodeSandbox server on that port. Covers address-bar
// navigation, iframes, and new tabs — beyond what `fetch` patching does.
//
// Usage (host page):
//   import { registerPreviewSW, handlePreviewMessage } from "./src/plugins/preview-routing.js";
//   await registerPreviewSW(); // registers src/preview-sw.js at /__virtual__/
//   navigator.serviceWorker.addEventListener("message", (e) => handlePreviewMessage(e, sandbox));
//
// Or as a plugin:
//   import { previewRoutingPlugin } from "./src/plugins/preview-routing.js";
//   registerPlugin(previewRoutingPlugin); // exposes the helpers, does NOT auto-register the SW

const SW_PATH = "/preview-sw.js";
const SW_SCOPE = "/__virtual__/";

/**
 * Register the preview Service Worker. Must be called from the host page
 * (not the sandbox). Returns a Promise that resolves when the SW is active.
 *
 * Requires HTTPS or localhost. The SW takes control on second navigation;
 * listen for `navigator.serviceWorker.controllerchange` or reload after
 * registration for first-load coverage.
 */
export async function registerPreviewSW(swUrl = SW_PATH) {
  if (!("serviceWorker" in navigator)) {
    throw new Error(
      "Preview routing requires Service Worker support (HTTPS or localhost).",
    );
  }
  const reg = await navigator.serviceWorker.register(swUrl, {
    scope: SW_SCOPE,
  });
  // Wait for activation so fetch handling works.
  if (reg.active) return reg;
  const worker = reg.installing || reg.waiting;
  if (!worker) return reg;
  await new Promise((resolve, reject) => {
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") resolve();
      else if (worker.state === "redundant") {
        reject(new Error("Service Worker became redundant during install"));
      }
    });
  });
  return reg;
}

/**
 * Handle a `__BVM_PREVIEW_REQUEST__` message from the Service Worker.
 * Forwards to the sandbox's server via the runtime bridge and posts the
 * response back through the MessagePort.
 *
 * @param {MessageEvent} event — the SW message event (has .ports[0])
 * @param {object} sandbox — the CodeSandbox instance (or an object with
 *   `handlePreviewRequest(port, path, method, headers, body)`)
 */
export async function handlePreviewMessage(event, sandbox) {
  const data = event.data;
  if (!data || data.type !== "__BVM_PREVIEW_REQUEST__") return false;
  const port = event.ports[0];
  if (!port) return true; // claimed but no port — SW will timeout

  try {
    const { port: reqPort, path, method, headers, body } = data;
    let result;
    if (sandbox && typeof sandbox.handlePreviewRequest === "function") {
      result = await sandbox.handlePreviewRequest(
        reqPort,
        path,
        method,
        headers,
        body,
      );
    } else if (
      sandbox &&
      sandbox._runtime &&
      typeof sandbox._runtime.__httpServerRunTime?.handleRequest === "function"
    ) {
      // Fallback: direct bridge access.
      result = await sandbox._runtime.__httpServerRunTime.handleRequest(
        reqPort,
        path,
        method,
        headers,
        body,
      );
    } else {
      throw new Error(
        `No server bridge available for preview routing (port ${reqPort})`,
      );
    }
    port.postMessage({
      status: result.status || 200,
      headers: result.headers || {},
      body: result.body || null,
    });
  } catch (err) {
    port.postMessage({ error: err.message || String(err) });
  }
  return true;
}

export const previewRoutingPlugin = {
  name: "preview-routing",
  builtIn: true,
  // Exposes the helpers; does NOT auto-register the SW (page-wide side
  // effects require explicit host opt-in).
};

export const PREVIEW_ROUTE_PREFIX = "/__virtual__/";
