// tests/fetch-platform.test.js — tests for src/fetch-patch.js
//
// The getSetCookie polyfill is defensive: it only installs when native
// getSetCookie is missing. These tests verify the polyfill logic by
// temporarily removing the native method.
import { installGetSetCookiePolyfill } from "../src/fetch-patch.js";

describe("fetch-patch: getSetCookie polyfill", () => {
  const native = Headers.prototype.getSetCookie;
  const hadNative = typeof native === "function";

  beforeEach(() => {
    // Remove native to force polyfill installation
    if (hadNative) {
      delete Headers.prototype.getSetCookie;
    }
    installGetSetCookiePolyfill();
  });

  afterEach(() => {
    // Restore native
    delete Headers.prototype.getSetCookie;
    if (hadNative) {
      Headers.prototype.getSetCookie = native;
    }
  });

  test("polyfill installs when native is missing", () => {
    expect(typeof Headers.prototype.getSetCookie).toBe("function");
  });

  test("does not overwrite native when present", () => {
    delete Headers.prototype.getSetCookie;
    if (hadNative) Headers.prototype.getSetCookie = native;
    const before = Headers.prototype.getSetCookie;
    installGetSetCookiePolyfill();
    expect(Headers.prototype.getSetCookie).toBe(before);
  });

  test("returns [] when no set-cookie header", () => {
    const h = new Headers({ "x-test": "1" });
    // Force polyfill path even if native exists
    delete Headers.prototype.getSetCookie;
    installGetSetCookiePolyfill();
    expect(h.getSetCookie()).toEqual([]);
  });

  test("parses manually-constructed set-cookie headers", () => {
    const h = new Headers();
    delete Headers.prototype.getSetCookie;
    installGetSetCookiePolyfill();
    // Manually append (not from network, so not filtered)
    h.append("set-cookie", "a=1; Path=/");
    h.append("set-cookie", "b=2; Path=/");
    const cookies = h.getSetCookie();
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies.length).toBe(2);
    expect(cookies[0]).toBe("a=1; Path=/");
    expect(cookies[1]).toBe("b=2; Path=/");
  });

  test("is idempotent (safe to call twice)", () => {
    delete Headers.prototype.getSetCookie;
    installGetSetCookiePolyfill();
    const first = Headers.prototype.getSetCookie;
    installGetSetCookiePolyfill();
    expect(Headers.prototype.getSetCookie).toBe(first);
  });

  test("polyfill is non-enumerable", () => {
    delete Headers.prototype.getSetCookie;
    installGetSetCookiePolyfill();
    const desc = Object.getOwnPropertyDescriptor(
      Headers.prototype,
      "getSetCookie",
    );
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(true);
    expect(desc.writable).toBe(true);
  });
});
