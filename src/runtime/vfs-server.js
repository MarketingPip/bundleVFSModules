// src/runtime/vfs-server.js — extracted verbatim from runtime.js
// (lines 2646-2808), branch modular/resolution. `export` added to every
// _vfs* function (the only change). `_vfsServerRoutes` / `_vfsOriginalFetch`
// stay module-private shared state. Consumers in other sections:
// ExecutionContext calls _vfsRegisterServerRoute / _vfsUnregisterServerRoute /
// _vfsExtractServerPort (runtime.js:3279-3300, 3781).
// VFS_FETCH_BRIDGE_START
// ── Host virtual-server fetch bridge ───────────────────────────────────────
// Patches the real parent/host 'fetch' (once) so requests to loopback URLs
// ('localhost', '127.0.0.1', '[::1]') on a port owned by a sandbox route to
// that sandbox's virtual HTTP server via 'invoke('__serverRequest__', …)'.
// One host-global registry: first claim wins, a colliding second claim is
// rejected so the host can revoke the loser. The patch is removed only after
// the final route disappears. Tested by tests/host-fetch-bridge.test.js,
// which evaluates this exact section in a vm sandbox with mocked globals.

/** port (number) -> ExecutionContext owning the active virtual server */
const _vfsServerRoutes = new Map();
/** The native fetch, captured while the patch is installed. */
let _vfsOriginalFetch = null;

export function _vfsIsLoopbackHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

export function _vfsExtractServerPort(data) {
  if (data && typeof data.port === "number") return data.port;
  // Sandbox posts server events via emitMe: { type, message: 'null {"port":N}' }.
  const msg = data && typeof data.message === "string" ? data.message : "";
  const m = /\{\s*"port"\s*:\s*(\d+)\s*\}/.exec(msg);
  return m ? Number(m[1]) : null;
}

export function _vfsEnsureFetchPatched() {
  if (typeof window === "undefined" || typeof window.fetch !== "function")
    return false;
  if (window.fetch && window.fetch.__vfsBridged) return true;
  _vfsOriginalFetch = window.fetch;
  _vfsPatchedFetch.__vfsBridged = true;
  window.fetch = _vfsPatchedFetch;
  return true;
}

export function _vfsMaybeRestoreFetch() {
  if (
    _vfsServerRoutes.size === 0 &&
    _vfsOriginalFetch &&
    typeof window !== "undefined"
  ) {
    window.fetch = _vfsOriginalFetch;
    _vfsOriginalFetch = null;
  }
}

/** Returns true when this owner holds the route (first claim wins). */
export function _vfsRegisterServerRoute(port, owner) {
  if (port == null) return false;
  const existing = _vfsServerRoutes.get(port);
  if (existing === owner) return true; // idempotent re-register
  if (existing !== undefined) return false; // collision
  _vfsServerRoutes.set(port, owner);
  _vfsEnsureFetchPatched();
  return true;
}

export function _vfsUnregisterServerRoute(port, owner) {
  if (port == null) return;
  if (_vfsServerRoutes.get(port) === owner) {
    _vfsServerRoutes.delete(port);
    _vfsMaybeRestoreFetch();
  }
}

export async function _vfsPatchedFetch(input, init) {
  let url = null;
  try {
    const raw = typeof input === "string" ? input : input && input.url;
    url = new URL(String(raw), window.location.href);
  } catch {
    return _vfsOriginalFetch.apply(this, arguments);
  }
  if (url && _vfsIsLoopbackHostname(url.hostname)) {
    const port = url.port
      ? Number(url.port)
      : url.protocol === "https:"
        ? 443
        : 80;
    const owner = _vfsServerRoutes.get(port);
    if (owner !== undefined) {
      return _vfsDispatchToSandbox(owner, port, url, input, init);
    }
  }
  return _vfsOriginalFetch.apply(this, arguments);
}

export async function _vfsDispatchToSandbox(owner, port, url, input, init) {
  const method = String(
    (init && init.method) ||
      (input && typeof input === "object" && input.method) ||
      "GET",
  ).toUpperCase();
  const headers = {};
  const absorb = (h) => {
    if (!h) return;
    if (typeof h.forEach === "function") {
      h.forEach((v, k) => {
        headers[String(k)] = String(v);
      });
    } else if (Array.isArray(h)) {
      for (const [k, v] of h) headers[String(k)] = String(v);
    } else if (typeof h === "object") {
      for (const k of Object.keys(h)) headers[k] = String(h[k]);
    }
  };
  absorb(input && typeof input === "object" ? input.headers : null);
  absorb(init && init.headers);
  let body = null;
  const rawBody =
    init && init.body !== undefined
      ? init.body
      : input && typeof input === "object"
        ? input.body
        : undefined;
  if (rawBody !== undefined && rawBody !== null) {
    if (
      typeof rawBody === "string" ||
      rawBody instanceof Uint8Array ||
      rawBody instanceof ArrayBuffer
    ) {
      body = rawBody;
    } else {
      body = String(rawBody);
    }
  }
  const path = url.pathname + url.search;
  let result;
  try {
    // __serverRequest__ treats {} as "no body" (see src/http.js handleRequest).
    result = await owner.invoke(
      "__serverRequest__",
      port,
      path,
      method,
      body === null ? {} : body,
      headers,
    );
  } catch (err) {
    // Owner died mid-flight: drop the stale route so later fetches go native.
    _vfsUnregisterServerRoute(port, owner);
    throw err;
  }
  let resBody = result && result.body;
  if (
    resBody !== undefined &&
    resBody !== null &&
    typeof resBody !== "string" &&
    !(resBody instanceof Uint8Array) &&
    !(resBody instanceof ArrayBuffer)
  ) {
    resBody = String(resBody);
  }
  return new Response(resBody == null ? "" : resBody, {
    status: (result && result.statusCode) || 200,
    statusText: (result && result.statusMessage) || "",
    headers: (result && result.headers) || {},
  });
}
// VFS_FETCH_BRIDGE_END
