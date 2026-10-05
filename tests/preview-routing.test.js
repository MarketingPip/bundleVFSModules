// tests/preview-routing.test.js — unit tests for the preview-routing
// plugin's pure logic (URL parsing, route registry, body normalization,
// error mapping). No Service Worker needed; the SW is a thin transport and
// the host (this module) is the authority.
//
// TDD: these tests were written BEFORE src/plugins/preview-routing.js.
import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import {
  parsePreviewUrl,
  PREVIEW_SCOPE,
  registerPreviewRoute,
  unregisterPreviewRoute,
  lookupPreviewRoute,
  clearPreviewRoutes,
  normalizePreviewBody,
  buildPreviewErrorHtml,
  previewRequestMessage,
  isPreviewRequest,
  isPreviewResponse,
  trackSandbox,
  waitForSWActive,
} from "../src/plugins/preview-routing.js";

beforeEach(() => {
  clearPreviewRoutes();
});

describe("parsePreviewUrl", () => {
  test("parses port and root path", () => {
    expect(parsePreviewUrl("/__virtual__/3000/")).toEqual({
      port: 3000,
      path: "/",
    });
  });

  test("parses port and nested path", () => {
    expect(parsePreviewUrl("/__virtual__/8080/api/users/1")).toEqual({
      port: 8080,
      path: "/api/users/1",
    });
  });

  test("missing trailing slash means root path", () => {
    expect(parsePreviewUrl("/__virtual__/3000")).toEqual({
      port: 3000,
      path: "/",
    });
  });

  test("non-numeric port is rejected", () => {
    expect(parsePreviewUrl("/__virtual__/abc/")).toBeNull();
  });

  test("port 0 is rejected", () => {
    expect(parsePreviewUrl("/__virtual__/0/")).toBeNull();
  });

  test("port above 65535 is rejected", () => {
    expect(parsePreviewUrl("/__virtual__/70000/")).toBeNull();
  });

  test("missing port is rejected", () => {
    expect(parsePreviewUrl("/__virtual__/")).toBeNull();
  });

  test("other prefixes are rejected", () => {
    expect(parsePreviewUrl("/other/3000/")).toBeNull();
    expect(parsePreviewUrl("/__virtual2__/3000/")).toBeNull();
  });

  test("non-string input is rejected", () => {
    expect(parsePreviewUrl(null)).toBeNull();
    expect(parsePreviewUrl(undefined)).toBeNull();
    expect(parsePreviewUrl(3000)).toBeNull();
  });

  test("scope constant is the documented prefix", () => {
    expect(PREVIEW_SCOPE).toBe("/__virtual__/");
  });
});

describe("preview route registry", () => {
  test("register then lookup returns the handler", () => {
    const h = async () => ({});
    expect(registerPreviewRoute(3000, h)).toBe(true);
    expect(lookupPreviewRoute(3000)).toBe(h);
  });

  test("first claim wins on collision", () => {
    const first = async () => ({ statusCode: 200 });
    const second = async () => ({ statusCode: 500 });
    expect(registerPreviewRoute(3000, first)).toBe(true);
    expect(registerPreviewRoute(3000, second)).toBe(false);
    expect(lookupPreviewRoute(3000)).toBe(first);
  });

  test("unregister removes the route", () => {
    const h = async () => ({});
    registerPreviewRoute(3000, h);
    expect(unregisterPreviewRoute(3000)).toBe(true);
    expect(lookupPreviewRoute(3000)).toBeUndefined();
    expect(unregisterPreviewRoute(3000)).toBe(false);
  });

  test("invalid ports are refused", () => {
    const h = async () => ({});
    expect(registerPreviewRoute(0, h)).toBe(false);
    expect(registerPreviewRoute(70000, h)).toBe(false);
    expect(registerPreviewRoute("3000", h)).toBe(false);
    expect(registerPreviewRoute(3000, null)).toBe(false);
  });

  test("clearPreviewRoutes empties the registry", () => {
    registerPreviewRoute(3000, async () => ({}));
    registerPreviewRoute(4000, async () => ({}));
    clearPreviewRoutes();
    expect(lookupPreviewRoute(3000)).toBeUndefined();
    expect(lookupPreviewRoute(4000)).toBeUndefined();
  });
});

describe("normalizePreviewBody", () => {
  test("null/undefined stay null", () => {
    expect(normalizePreviewBody(null)).toBeNull();
    expect(normalizePreviewBody(undefined)).toBeNull();
  });

  test("string is UTF-8 encoded", () => {
    const buf = normalizePreviewBody("hello");
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(buf)).toBe("hello");
  });

  test("Uint8Array is copied to a fresh ArrayBuffer", () => {
    const u8 = new Uint8Array([1, 2, 3]);
    const buf = normalizePreviewBody(u8);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3]));
    // Must not alias the input's buffer (may be a view into a pool).
    expect(buf).not.toBe(u8.buffer);
  });

  test("ArrayBuffer passes through", () => {
    const ab = new Uint8Array([9]).buffer;
    expect(normalizePreviewBody(ab)).toBe(ab);
  });

  test("other types become strings", () => {
    const buf = normalizePreviewBody(42);
    expect(new TextDecoder().decode(buf)).toBe("42");
  });
});

describe("buildPreviewErrorHtml", () => {
  test("mentions the port and a fix hint", () => {
    const html = buildPreviewErrorHtml(502, "boom", 3000);
    expect(html).toContain("502");
    expect(html).toContain("3000");
    expect(html).toContain("http.createServer");
  });

  test("escapes HTML in the message (no injection)", () => {
    const html = buildPreviewErrorHtml(500, "<script>alert(1)</script>", 3000);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("works without a port", () => {
    const html = buildPreviewErrorHtml(504, "timeout");
    expect(html).toContain("504");
  });
});

describe("SW message protocol", () => {
  test("previewRequestMessage builds the wire shape", () => {
    const msg = previewRequestMessage({
      id: "abc",
      port: 3000,
      method: "POST",
      pathname: "/__virtual__/3000/echo",
      search: "?x=1",
      headers: { "content-type": "text/plain" },
      body: null,
    });
    expect(msg).toEqual({
      type: "bvm:preview-request",
      id: "abc",
      port: 3000,
      method: "POST",
      pathname: "/__virtual__/3000/echo",
      search: "?x=1",
      headers: { "content-type": "text/plain" },
      body: null,
    });
  });

  test("isPreviewRequest / isPreviewResponse discriminate", () => {
    expect(
      isPreviewRequest({ type: "bvm:preview-request", id: "x" }),
    ).toBe(true);
    expect(isPreviewRequest({ type: "bvm:preview-response", id: "x" })).toBe(
      false,
    );
    expect(isPreviewRequest(null)).toBe(false);
    expect(
      isPreviewResponse({ type: "bvm:preview-response", id: "x", ok: true }),
    ).toBe(true);
    expect(isPreviewResponse({ type: "bvm:preview-request" })).toBe(false);
  });
});

describe("waitForSWActive", () => {
  function fakeReg(state) {
    // Minimal ServiceWorkerRegistration stand-in.
    const listeners = {};
    const sw = {
      state,
      addEventListener(evt, fn) {
        (listeners[evt] = listeners[evt] || []).push(fn);
      },
      removeEventListener(evt, fn) {
        listeners[evt] = (listeners[evt] || []).filter((f) => f !== fn);
      },
      _fire() {
        for (const fn of listeners.statechange || []) fn();
      },
    };
    return {
      active: state === "activated" ? sw : null,
      installing: state === "installing" ? sw : null,
      waiting: state === "waiting" ? sw : null,
      _sw: sw,
    };
  }

  test("resolves immediately when already active", async () => {
    const reg = fakeReg("activated");
    await expect(waitForSWActive(reg, 1000)).resolves.toBe(reg._sw);
  });

  test("waits for installing worker to activate", async () => {
    const reg = fakeReg("installing");
    const p = waitForSWActive(reg, 5000);
    // Simulate the browser activating the worker.
    reg._sw.state = "activated";
    reg.active = reg._sw;
    reg.installing = null;
    reg._sw._fire();
    await expect(p).resolves.toBe(reg._sw);
  });

  test("rejects on timeout", async () => {
    const reg = fakeReg("installing"); // never activates
    await expect(waitForSWActive(reg, 150)).rejects.toThrow(/timed out/i);
  });

  test("documents why navigator.serviceWorker.ready is not used", () => {
    // ready only resolves for scopes covering the current page; preview
    // hosts live outside /__virtual__/, so ready would hang forever.
    // This test pins the design decision, not browser behavior.
    expect(typeof waitForSWActive).toBe("function");
  });
});

describe("trackSandbox", () => {
  function fakeSandbox() {
    const listeners = {};
    return {
      _listeners: listeners,
      on(evt, fn) {
        (listeners[evt] = listeners[evt] || []).push(fn);
      },
      emit(evt, arg) {
        for (const fn of listeners[evt] || []) fn(arg);
      },
      invoke: jest.fn(async () => ({
        statusCode: 200,
        statusMessage: "OK",
        headers: {},
        body: "hi",
      })),
    };
  }

  test("server open registers a route; close unregisters", () => {
    const sb = fakeSandbox();
    const untrack = trackSandbox(sb);
    sb.emit("execution:server", { type: "open", port: 3100 });
    expect(lookupPreviewRoute(3100)).toBeDefined();
    sb.emit("execution:server", { type: "closed", port: 3100 });
    expect(lookupPreviewRoute(3100)).toBeUndefined();
    untrack();
  });

  test("registered handler invokes __serverRequest__ with the bridge shape", async () => {
    const sb = fakeSandbox();
    trackSandbox(sb);
    sb.emit("execution:server", { type: "open", port: 3100 });
    const handler = lookupPreviewRoute(3100);
    const result = await handler({
      method: "GET",
      path: "/hello?x=1",
      headers: { accept: "text/html" },
      body: null,
    });
    expect(sb.invoke).toHaveBeenCalledWith(
      "__serverRequest__",
      3100,
      "/hello?x=1",
      "GET",
      {},
      { accept: "text/html" },
    );
    expect(result.statusCode).toBe(200);
  });

  test("untrack removes routes owned by that sandbox", () => {
    const sb = fakeSandbox();
    const untrack = trackSandbox(sb);
    sb.emit("execution:server", { type: "open", port: 3200 });
    untrack();
    expect(lookupPreviewRoute(3200)).toBeUndefined();
  });
});
