/**
 * Tests for the Worker C ("resolution") extracted modules:
 *   src/runtime/syntax.js          (SyntaxChecker)
 *   src/runtime/events.js          (EventEmitter)
 *   src/runtime/import-resolver.js (ImportResolver)
 *   src/runtime/vfs-server.js      (VFS fetch bridge)
 *
 * The modules keep their host-scope globals as bare references (same as the
 * original runtime.js module scope); the tests install faithful equivalents
 * on globalThis before exercising them.
 */
import { describe, test, expect, jest, afterEach } from "@jest/globals";
import * as acorn from "acorn";
import { builtinModules as nodeBuiltins } from "node:module";

import { SyntaxChecker } from "../src/runtime/syntax.js";
import { EventEmitter } from "../src/runtime/events.js";
import { ImportResolver } from "../src/runtime/import-resolver.js";
import {
  _vfsIsLoopbackHostname,
  _vfsExtractServerPort,
  _vfsEnsureFetchPatched,
  _vfsRegisterServerRoute,
  _vfsUnregisterServerRoute,
  _vfsPatchedFetch,
  _vfsDispatchToSandbox,
} from "../src/runtime/vfs-server.js";

// ── Host globals the extracted modules read as bare references ──────────────
// syntax.js reads `acorn`; import-resolver.js reads `customAcorn`,
// `normalizeBuiltinSpecifier`, `builtinModules`, `isViteBrowserInterceptionActive`
// and `lookupNativeInterception`.
globalThis.acorn = acorn;
globalThis.customAcorn = acorn; // plain acorn suffices for standard imports
// Faithful copy of runtime.js normalizeBuiltinSpecifier for the `node:` prefix
// path (the esm.sh/underscore branches are not exercised here).
globalThis.normalizeBuiltinSpecifier = (specifier, nodeBuiltinsList) => {
  var modulePath = specifier;
  var bare =
    typeof specifier === "string" && specifier.indexOf("node:") === 0
      ? specifier.slice(5)
      : specifier;
  var listed = false;
  for (var i = 0; i < nodeBuiltinsList.length; i++) {
    if (nodeBuiltinsList[i] === specifier || nodeBuiltinsList[i] === bare)
      listed = true;
  }
  var isNodeBuiltIn = listed;
  if (isNodeBuiltIn) {
    modulePath = String(bare).replace("/", "_").replace("RUNTIME:", "RUNTIME_");
  }
  return { isNodeBuiltIn: isNodeBuiltIn, modulePath: modulePath };
};
globalThis.builtinModules = nodeBuiltins;
globalThis.isViteBrowserInterceptionActive = () => false;
globalThis.lookupNativeInterception = () => null;

// ════════════════════════════════════════════════════════════════════════════
describe("SyntaxChecker", () => {
  test("accepts valid module code", () => {
    expect(
      new SyntaxChecker().check("const x = 1;\nexport default x;"),
    ).toEqual({ valid: true });
  });

  test("throws on invalid code", () => {
    expect(() => new SyntaxChecker().check("const = ;")).toThrow();
  });

  test("honours the ecmaVersion option", () => {
    const sc = new SyntaxChecker({ ecmaVersion: 2020 });
    expect(sc.ecmaVersion).toBe(2020);
    expect(sc.check("const x = 1;").valid).toBe(true);
  });

  test("allows top-level await", () => {
    expect(new SyntaxChecker().check("await Promise.resolve(1);").valid).toBe(
      true,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("EventEmitter", () => {
  test("on/emit delivers data to handlers", () => {
    const ee = new EventEmitter();
    const seen = [];
    ee.on("msg", (d) => seen.push(d));
    ee.emit("msg", 42);
    expect(seen).toEqual([42]);
  });

  test("on returns an unsubscribe function", () => {
    const ee = new EventEmitter();
    const seen = [];
    const off = ee.on("msg", (d) => seen.push(d));
    off();
    ee.emit("msg", 1);
    expect(seen).toEqual([]);
  });

  test("off removes a specific handler", () => {
    const ee = new EventEmitter();
    const a = [],
      b = [];
    const ha = (d) => a.push(d);
    const hb = (d) => b.push(d);
    ee.on("e", ha);
    ee.on("e", hb);
    ee.off("e", ha);
    ee.emit("e", "x");
    expect(a).toEqual([]);
    expect(b).toEqual(["x"]);
  });

  test("emit with no handlers does not throw", () => {
    expect(() => new EventEmitter().emit("nothing")).not.toThrow();
  });

  test("a throwing handler does not break the others", () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const ee = new EventEmitter();
    const seen = [];
    ee.on("e", () => {
      throw new Error("boom");
    });
    ee.on("e", (d) => seen.push(d));
    ee.emit("e", "ok");
    expect(seen).toEqual(["ok"]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("ImportResolver", () => {
  const resolver = () =>
    new ImportResolver({ cdnBase: "https://esm.sh", fallbackCDN: true });

  test("rewrites bare npm specifiers to the CDN", () => {
    const r = resolver().resolve(`import _ from "lodash";`);
    expect(r.hasImportsOrRequires).toBe(true);
    expect(r.cleanedImports.imports).toEqual(["https://esm.sh/lodash"]);
    // static import statements are stripped from cleanedCode (tracked in r.imports)
    expect(r.imports[0]).toContain("'https://esm.sh/lodash'");
  });

  test("passes builtins through untouched (bare and node: prefixed)", () => {
    const r = resolver().resolve(
      `import fs from "fs";\nimport path from "node:path";`,
    );
    expect(r.cleanedImports.imports).toEqual(["fs", "node:path"]);
    expect(r.imports[0]).toContain(`from 'fs'`);
    expect(r.imports[1]).toContain(`from 'node:path'`);
  });

  test("passes relative and absolute VFS paths through", () => {
    const r = resolver().resolve(
      `import a from "./a.js";\nimport b from "/vfs/b.js";`,
    );
    expect(r.cleanedImports.imports).toEqual(["./a.js", "/vfs/b.js"]);
  });

  test("passes absolute URLs through", () => {
    const r = resolver().resolve(`import x from "https://cdn.example/x.mjs";`);
    expect(r.cleanedImports.imports).toEqual(["https://cdn.example/x.mjs"]);
  });

  test("rewrites require() and dynamic import()", () => {
    const r = resolver().resolve(
      `const _ = require("lodash");\nconst m = await import("axios");`,
    );
    expect(r.requires).toEqual([`require('https://esm.sh/lodash')`]);
    expect(r.dynamicImports).toEqual([`import('https://esm.sh/axios')`]);
    expect(r.cleanedImports.requires).toEqual(["https://esm.sh/lodash"]);
    expect(r.cleanedImports.dynamicImports).toEqual(["https://esm.sh/axios"]);
    expect(r.hasImportsOrRequires).toBe(true);
  });

  test("returns empty result for code with no imports", () => {
    const r = resolver().resolve(`const x = 1;`);
    expect(r.hasImportsOrRequires).toBe(false);
    expect(r.cleanedCode).toBe("const x = 1;");
  });

  test("custom transform rules run before the CDN fallback", () => {
    const r = resolver();
    r.addTransformRule(
      (src) => src === "special",
      () => "https://internal.example/special.mjs",
    );
    const out = r.resolve(`import s from "special";`);
    expect(out.cleanedImports.imports).toEqual([
      "https://internal.example/special.mjs",
    ]);
  });

  test("cache makes repeat transforms free", () => {
    const r = resolver();
    let calls = 0;
    r.addTransformRule(/.+/, (src) => {
      calls++;
      return src;
    });
    r.resolve(`import a from "lodash";`);
    const before = calls;
    r.resolve(`import a from "lodash";`);
    expect(calls).toBe(before); // cache hit: no new rule invocation
  });

  test("clearCache empties the transform cache", () => {
    const r = resolver();
    r.resolve(`import a from "lodash";`);
    expect(r.cache.size).toBeGreaterThan(0);
    r.clearCache();
    expect(r.cache.size).toBe(0);
  });

  test("no CDN fallback without fallbackCDN option", () => {
    const r = new ImportResolver().resolve(`import _ from "lodash";`);
    expect(r.cleanedImports.imports).toEqual(["lodash"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("VFS fetch bridge (vfs-server.js)", () => {
  const ports = [];
  const track = (port) => {
    ports.push(port);
    return port;
  };
  afterEach(() => {
    for (const p of ports.splice(0)) _vfsUnregisterServerRoute(p, OWNER);
  });

  const OWNER = { id: "owner-1" };
  const OTHER = { id: "owner-2" };

  const mockWindow = (nativeImpl) => {
    const nativeFetch = jest.fn(nativeImpl);
    globalThis.window = {
      fetch: nativeFetch,
      location: { href: "http://host.test/" },
    };
    return nativeFetch;
  };

  test("_vfsIsLoopbackHostname matches loopback forms only", () => {
    expect(_vfsIsLoopbackHostname("localhost")).toBe(true);
    expect(_vfsIsLoopbackHostname("127.0.0.1")).toBe(true);
    expect(_vfsIsLoopbackHostname("::1")).toBe(true);
    expect(_vfsIsLoopbackHostname("[::1]")).toBe(true);
    expect(_vfsIsLoopbackHostname("LOCALHOST")).toBe(true);
    expect(_vfsIsLoopbackHostname("example.com")).toBe(false);
    expect(_vfsIsLoopbackHostname("")).toBe(false);
  });

  test("_vfsExtractServerPort reads port objects and emitMe messages", () => {
    expect(_vfsExtractServerPort({ port: 8080 })).toBe(8080);
    expect(_vfsExtractServerPort({ message: 'null {"port":3000}' })).toBe(3000);
    expect(_vfsExtractServerPort({})).toBeNull();
    expect(_vfsExtractServerPort(null)).toBeNull();
  });

  test("first claim wins; re-register by same owner is idempotent", () => {
    const port = track(18081);
    expect(_vfsRegisterServerRoute(port, OWNER)).toBe(true);
    expect(_vfsRegisterServerRoute(port, OWNER)).toBe(true); // idempotent
    expect(_vfsRegisterServerRoute(port, OTHER)).toBe(false); // collision
  });

  test("registering patches window.fetch; final unregister restores it", () => {
    const nativeFetch = mockWindow(async () => new Response("native"));
    const port = track(18082);
    const before = globalThis.window.fetch;
    _vfsRegisterServerRoute(port, OWNER);
    expect(globalThis.window.fetch.__vfsBridged).toBe(true);
    expect(globalThis.window.fetch).not.toBe(before);
    _vfsUnregisterServerRoute(port, OWNER);
    expect(globalThis.window.fetch).toBe(nativeFetch);
  });

  test("unregister by a non-owner does not release the route", () => {
    const mockNative = mockWindow(async () => new Response("native"));
    const port = track(18083);
    _vfsRegisterServerRoute(port, OWNER);
    _vfsUnregisterServerRoute(port, OTHER);
    expect(globalThis.window.fetch.__vfsBridged).toBe(true);
    _vfsUnregisterServerRoute(port, OWNER);
    expect(globalThis.window.fetch).toBe(mockNative);
  });

  test("_vfsPatchedFetch dispatches loopback URLs to the sandbox owner", async () => {
    mockWindow(async () => new Response("native", { status: 200 }));
    const owner = {
      invoke: jest.fn(async () => ({
        statusCode: 201,
        statusMessage: "Created",
        headers: { "x-test": "1" },
        body: '{"ok":true}',
      })),
    };
    const port = track(18084);
    _vfsRegisterServerRoute(port, owner);
    const res = await _vfsPatchedFetch(`http://localhost:${port}/api`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('{"ok":true}');
    const [name, p, path, method, body, headers] = owner.invoke.mock.calls[0];
    expect(name).toBe("__serverRequest__");
    expect(p).toBe(port);
    expect(path).toBe("/api");
    expect(method).toBe("POST");
    expect(body).toBe('{"a":1}');
    expect(headers["content-type"]).toBe("application/json");
  });

  test("_vfsPatchedFetch falls through to native fetch for non-loopback hosts", async () => {
    const nativeFetch = mockWindow(async () => new Response("native-body"));
    const port = track(18085);
    _vfsRegisterServerRoute(port, OWNER);
    const res = await _vfsPatchedFetch("https://example.com/x");
    expect(nativeFetch).toHaveBeenCalled();
    expect(await res.text()).toBe("native-body");
  });

  test("_vfsPatchedFetch falls through when no route owns the port", async () => {
    const nativeFetch = mockWindow(async () => new Response("native-body"));
    _vfsEnsureFetchPatched();
    const res = await _vfsPatchedFetch("http://127.0.0.1:19999/none");
    expect(nativeFetch).toHaveBeenCalled();
    expect(await res.text()).toBe("native-body");
  });

  test("a dying owner unregisters its route so later fetches go native", async () => {
    const nativeFetch = mockWindow(async () => new Response("native-body"));
    const dying = {
      invoke: jest.fn(async () => {
        throw new Error("sandbox gone");
      }),
    };
    const port = track(18086);
    _vfsRegisterServerRoute(port, dying);
    await expect(_vfsPatchedFetch(`http://localhost:${port}/`)).rejects.toThrow(
      "sandbox gone",
    );
    // Route dropped; next fetch goes native even though the registry was patched.
    const res = await _vfsPatchedFetch(`http://localhost:${port}/`);
    expect(nativeFetch).toHaveBeenCalled();
    expect(await res.text()).toBe("native-body");
  });

  test("_vfsDispatchToSandbox coerces bodies and defaults GET", async () => {
    const owner = {
      invoke: jest.fn(async () => ({ body: { nested: "obj" } })),
    };
    const res = await _vfsDispatchToSandbox(
      owner,
      8080,
      new URL("http://localhost:8080/a?b=1"),
      null,
      undefined,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("[object Object]");
    expect(owner.invoke.mock.calls[0][3]).toBe("GET");
    expect(owner.invoke.mock.calls[0][2]).toBe("/a?b=1");
  });
});
