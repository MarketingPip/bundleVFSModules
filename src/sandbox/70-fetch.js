// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.

// Enhanced fetch tracking with timeout and abort support

function wrapNetwork(fnName, origFn, blocker) {
  return function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    if (blocker(url)) throw new Error(`Blocked ${fnName} to ${url}`);
    return origFn(...args);
  };
}

const _realFetch = window.fetch;
const pendingFetches = new Map();

// Create the patched fetch

const patchedFetch = async function (input, init = {}) {
  const requestInfo = typeof input === "string" ? input : input?.url;
  const requestId = Math.random().toString(36).substr(2, 9);

  const blockedUrls = ["https://example.com/bad"];

  const url = typeof input === "string" ? input : input.url;

  if (
    blockedUrls.some((pattern) =>
      typeof pattern === "string" ? pattern === url : pattern.test(url),
    )
  ) {
    return Promise.reject(new Error(`Blocked fetch to ${url}`));
  }

  emitMe("network_request", null, {
    url: input,
    id: requestId,
    type: "fetch",
    status: "started",
    body: init,
  });

  // ── Fetch audit 2026-10-11: normalize Request inputs ────────────────────
  // The parent interop crosses postMessage (structured clone); a Request
  // object is not cloneable, so passing it through produced an unhandled
  // rejection. Serialize to (url, init) for the parent path instead. The
  // native fallback below still receives the ORIGINAL input, so Request
  // semantics (body locking, signal) are preserved when the parent is
  // skipped.
  const originalInput = input;
  if (typeof Request !== "undefined" && input instanceof Request) {
    const reqHeaders = {};
    input.headers.forEach((v, k) => {
      reqHeaders[k] = v;
    });
    const fromReq = {
      method: input.method,
      headers: reqHeaders,
      referrer: input.referrer,
      referrerPolicy: input.referrerPolicy,
      mode: input.mode,
      credentials: input.credentials,
      cache: input.cache,
      redirect: input.redirect,
      integrity: input.integrity,
      keepalive: input.keepalive,
    };
    // Explicit init wins over the Request's fields (fetch spec).
    init = { ...fromReq, ...init };
    // Carry the Request's signal when the caller passed none (fetch spec).
    if (!init.signal && input.signal) init.signal = input.signal;
    input = input.url;
    // Buffer the body via a clone so the original Request stays usable for
    // the native fallback. NOTE: Firefox does not implement
    // Request.prototype.body (it is undefined — verified 2026-10-11), so we
    // cannot test for a null body; instead read the clone and treat an empty
    // buffer as no body. GET/HEAD never have bodies (the constructor throws
    // otherwise).
    if (originalInput.method !== "GET" && originalInput.method !== "HEAD") {
      let buf = null;
      try {
        buf = await originalInput.clone().arrayBuffer();
      } catch (e) {
        // Unusable body (already consumed / locked stream): the fetch spec
        // rejects this with a TypeError.
        throw new TypeError("Failed to fetch: request body is already used");
      }
      if (buf && buf.byteLength > 0) init.body = buf;
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  // ── Fetch audit 2026-10-11: honor the caller's AbortSignal ──────────────
  // Previously the wrapper silently replaced the user's signal with its own,
  // so AbortController.abort() had no effect (undici divergence: undici
  // rejects with AbortError). Compose: a user abort trips the internal
  // controller.
  const userSignal = init.signal;
  const onUserAbort = () => controller.abort();
  if (userSignal) {
    if (userSignal.aborted) {
      controller.abort();
    } else if (typeof userSignal.addEventListener === "function") {
      userSignal.addEventListener("abort", onUserAbort, { once: true });
    }
  }
  const fetchInit = { ...init, signal: controller.signal };
  // Race the parent interop wait against abort: the interop promise is not
  // tied to the controller, so without this both user aborts and the 30s
  // timeout were silently ignored on the parent path.
  const abortRace = new Promise((_, reject) => {
    if (controller.signal.aborted) {
      reject(new DOMException("This operation was aborted", "AbortError"));
    } else {
      controller.signal.addEventListener(
        "abort",
        () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        },
        { once: true },
      );
    }
  });
  abortRace.catch(() => {}); // the losing branch must not reject unhandled

  let hasError = null;
  let response;

  try {
    const { signal, ...serializableInit } = fetchInit;

    if (serializableInit.headers) {
      const h = serializableInit.headers;

      serializableInit.headers =
        h instanceof Headers
          ? Object.fromEntries(h.entries())
          : Array.isArray(h)
            ? Object.fromEntries(h)
            : { ...h };
    }

    let fetchPromise;

    // pendingFetches.set(requestId, { url: requestInfo, promise: fetchPromise });

    try {
      // 🔥 FIRST: Try parent
      if (serializableInit.body) {
        // serializableInit.body = JSON.parse(serializableInit.body)
      }
      const parentFetch = globalThis.__INTEROP_VAR__?.callParent?.(
        "_fetch_",
        input,
        serializableInit,
      );

      if (parentFetch == null) {
        throw new Error("Parent declined fetch");
      }

      fetchPromise = parentFetch;

      self.operations?.fetches?.add(fetchPromise);
      // .finally() returns a new promise: without a no-op catch it surfaces
      // as an unhandled rejection when the interop call fails (the await
      // below is what actually reports the error).
      const tracked = fetchPromise.finally(() =>
        self.operations?.fetches?.delete(fetchPromise),
      );
      tracked.catch(() => {});

      response = await Promise.race([fetchPromise, abortRace]);
      if (!response) {
        throw new Error("Parent Fetch Returned Null");
      }

      const res = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });

      // ── Fetch audit 2026-10-11: preserve undici-visible response fields.
      // The parent reports the post-redirect URL, the redirect flag and the
      // response type; without these the reconstruction always showed
      // redirected=false, type="default" and the pre-redirect URL.
      Object.defineProperty(res, "url", { value: response.url });
      if (typeof response.redirected === "boolean") {
        Object.defineProperty(res, "redirected", {
          value: response.redirected,
        });
      }
      if (typeof response.type === "string") {
        Object.defineProperty(res, "type", { value: response.type });
      }
      return res;
    } catch (parentError) {
      // 🔥 Parent failed — fallback to real fetch
      ("__LOG_FETCH_PARENT_FALLBACK__");

      // An abort (user or timeout) won the race: propagate it. Retrying
      // natively after an abort would un-abort the request.
      if (parentError && parentError.name === "AbortError") throw parentError;

      // Use the ORIGINAL input for the fallback: the serialized `input`
      // may hold a buffered body, but native fetch implements Request
      // semantics (signal/body locking) itself.
      fetchPromise = _realFetch.apply(window, [originalInput, fetchInit]);

      self.operations?.fetches?.add(fetchPromise);
      const tracked2 = fetchPromise.finally(() =>
        self.operations?.fetches?.delete(fetchPromise),
      );
      tracked2.catch(() => {});

      response = await fetchPromise;
    }

    // "__LOG_FETCH_COMPLETED__";

    return response;
  } catch (error) {
    hasError = error;

    if (error.name === "AbortError") {
      ("__LOG_FETCH_TIMEOUT__");
    } else {
      ("__LOG_FETCH_FAILED__");
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (userSignal && typeof userSignal.removeEventListener === "function") {
      userSignal.removeEventListener("abort", onUserAbort);
    }

    if (!hasError) {
      emitMe("network_request", null, {
        url: input,
        id: requestId,
        type: "fetch",
        status: "finished",
      });
    } else {
      emitMe("network_request", null, {
        url: input,
        id: requestId,
        type: "fetch",
        status: "failed",
        error: hasError?.message || hasError,
      });
    }

    pendingFetches.delete(requestId);
  }
};

const patchedFetch2 = async function (input, init = {}) {
  const requestInfo = typeof input === "string" ? input : input.url;
  const requestId = Math.random().toString(36).substr(2, 9);

  const blockedUrls = [
    "https://example.com/bad",
    //https:////malware.site///
  ];
  const url = input;

  // Check blocked URLs
  if (
    blockedUrls.some((pattern) =>
      typeof pattern === "string" ? pattern === url : pattern.test(url),
    )
  ) {
    return Promise.reject(new Error(`Blocked fetch to ${url}`));
  }

  emitMe("network_request", null, {
    url: input,
    id: requestId,
    type: "fetch",
    status: "started",
    body: init,
  });
  ("__LOG_FETCH_STARTED__");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  const fetchInit = { ...init, signal: controller.signal };

  // We use .apply(window) to ensure 'this' context is correct
  const fetchPromise = _realFetch.apply(window, [input, fetchInit]);

  pendingFetches.set(requestId, { url: requestInfo, promise: fetchPromise });
  let hasError = false;
  try {
    const response = await fetchPromise;
    ("__LOG_FETCH_COMPLETED__");
    return response;
  } catch (error) {
    if (error.name === "AbortError") {
      ("__LOG_FETCH_TIMEOUT__");
    } else {
      ("__LOG_FETCH_FAILED__");
    }
    hasError = error;
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (!hasError) {
      emitMe("network_request", null, {
        url: input,
        id: requestId,
        type: "fetch",
        status: "finished",
      });
    }
    if (hasError) {
      emitMe("network_request", null, {
        url: input,
        id: requestId,
        type: "fetch",
        status: "failed",
        error: hasError?.message || hasError,
      });
    }

    pendingFetches.delete(requestId);
  }
};

// MASKING: Make the patched function look exactly like the native one
Object.defineProperty(patchedFetch, "name", { value: "fetch" });
patchedFetch.toString = () => "function fetch() { [native code] }";

// LOCKING: Replace global fetch and prevent modification
Object.defineProperty(window, "fetch", {
  value: patchedFetch,
  writable: true,
  configurable: true,
  enumerable: true,
});

function waitForAllFetches() {
  const promises = Array.from(pendingFetches.values()).map((f) => f.promise);
  return Promise.allSettled(promises);
}
