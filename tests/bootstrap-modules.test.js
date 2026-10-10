import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// Worker A (bootstrap) extraction tests: src/runtime/{bootstrap,builtins,
// terminal,builtin-modules,transpile,vfs-serialize}.js must each import
// directly under Node (dual-lane imports per the src/plugins/typescript.js
// precedent) and behave exactly like the runtime.js lines they were cut from.

import {
  isViteBrowserInterceptionActive,
  lookupNativeInterception,
  registerPlugin,
  typescriptPlugin,
  jsonPlugin,
} from "../src/runtime/bootstrap.js";
import {
  registerPlugin as regPlugin,
  unregisterPlugin,
  getPlugins,
  clearPlugins,
} from "../src/plugins.js";
import { viteBrowserPlugin } from "../src/plugins/vite-browser.js";

import {
  COOKIE_JAR_IIFE,
  _builtinCache,
  _builtinBaseUrl,
  _builtinManifest,
  _builtinSourceCache,
  fetchBuiltinSource,
  normalizeBuiltinSpecifier,
  loadBuiltin,
} from "../src/runtime/builtins.js";

import {
  toNodeKeypress,
  stripAnsi,
  mergeProcess,
} from "../src/runtime/terminal.js";

import { builtinModules } from "../src/runtime/builtin-modules.js";

import {
  transpileTypeScript,
  customAcorn,
} from "../src/runtime/transpile.js";

import {
  TEXT_EXTS,
  BINARY_EXTS,
  getExt,
  serializeVfs,
  deserializeVfs,
  rehydrateVfs,
  memfsFs,
} from "../src/runtime/vfs-serialize.js";

// ─── bootstrap.js ────────────────────────────────────────────────────────────

describe("bootstrap: vite browser interception gate", () => {
  beforeEach(() => {
    clearPlugins();
  });

  test("inactive when vite-browser plugin is not registered", () => {
    expect(isViteBrowserInterceptionActive()).toBe(false);
  });

  test("active once the host opts in via registerPlugin(viteBrowserPlugin)", () => {
    regPlugin(viteBrowserPlugin);
    expect(isViteBrowserInterceptionActive()).toBe(true);
    unregisterPlugin("vite-browser");
    expect(isViteBrowserInterceptionActive()).toBe(false);
  });

  test("other plugins do not activate the gate", () => {
    regPlugin(typescriptPlugin);
    regPlugin(jsonPlugin);
    expect(isViteBrowserInterceptionActive()).toBe(false);
    expect(getPlugins().length).toBeGreaterThanOrEqual(2);
  });
});

describe("bootstrap: lookupNativeInterception re-export", () => {
  test("rollup resolves to the browser build", () => {
    expect(lookupNativeInterception("rollup")).toContain("rollup");
  });

  test("node: builtins and relative paths are never intercepted", () => {
    expect(lookupNativeInterception("node:fs")).toBeNull();
    expect(lookupNativeInterception("./local.js")).toBeNull();
    expect(lookupNativeInterception("")).toBeNull();
  });
});

// ─── builtins.js ─────────────────────────────────────────────────────────────

describe("builtins: manifest + caches", () => {
  test("_builtinManifest mirrors dist/manifest.json entries", () => {
    expect(_builtinManifest["fs"]).toBe("fs.js");
    expect(_builtinManifest["fs/promises"]).toBe("fs_promises.js");
    expect(_builtinManifest["timers/promises"]).toBe("timers_promises.js");
    expect(_builtinManifest["node:test/reporters"]).toBeUndefined();
  });

  test("caches are Maps and base URL points at jsDelivr", () => {
    expect(_builtinCache).toBeInstanceOf(Map);
    expect(_builtinSourceCache).toBeInstanceOf(Map);
    expect(_builtinBaseUrl).toContain("cdn.jsdelivr.net");
  });

  test("COOKIE_JAR_IIFE is the inlined cookie jar bundle", () => {
    expect(typeof COOKIE_JAR_IIFE).toBe("string");
    expect(COOKIE_JAR_IIFE.startsWith("globalThis.__cookieJarLib=")).toBe(true);
  });

  test("loadBuiltin is exposed on globalThis (runtime.js contract)", () => {
    expect(globalThis.loadBuiltin).toBe(loadBuiltin);
  });
});

describe("builtins: normalizeBuiltinSpecifier", () => {
  test("node: prefix is stripped for every builtin", () => {
    expect(normalizeBuiltinSpecifier("node:fs", builtinModules)).toEqual({
      isNodeBuiltIn: true,
      modulePath: "fs",
    });
  });

  test("slash becomes underscore in the bundle-key form", () => {
    expect(
      normalizeBuiltinSpecifier("node:test/reporters", builtinModules),
    ).toEqual({ isNodeBuiltIn: true, modulePath: "test_reporters" });
  });

  test("underscore-normalized spelling also resolves", () => {
    const r = normalizeBuiltinSpecifier("fs_promises", builtinModules);
    expect(r.isNodeBuiltIn).toBe(true);
    expect(r.modulePath).toBe("fs_promises");
  });

  test("RUNTIME: prefix becomes RUNTIME_", () => {
    const r = normalizeBuiltinSpecifier(
      "RUNTIME:NODE_GLOBALS",
      builtinModules,
    );
    expect(r.isNodeBuiltIn).toBe(true);
    expect(r.modulePath).toBe("RUNTIME_NODE_GLOBALS");
  });

  test("non-builtins pass through untouched", () => {
    expect(normalizeBuiltinSpecifier("express", builtinModules)).toEqual({
      isNodeBuiltIn: false,
      modulePath: "express",
    });
  });

  test("esm.sh-style /node/<name>.mjs paths are stripped", () => {
    const r = normalizeBuiltinSpecifier("/node/buffer.mjs", builtinModules);
    expect(r.isNodeBuiltIn).toBe(true);
    expect(r.modulePath).toBe("buffer");
  });

  test("source stays self-contained for sandbox inlining (no backticks/${)", () => {
    const src = normalizeBuiltinSpecifier.toString();
    expect(src).not.toContain("`");
    expect(src).not.toContain("${");
  });
});

describe("builtins: fetchBuiltinSource", () => {
  const realFetch = globalThis.fetch;
  let calls;
  afterEach(() => {
    globalThis.fetch = realFetch;
    _builtinSourceCache.clear();
  });

  beforeEach(() => {
    calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, text: async () => `// source for ${url}` };
    };
  });

  test("fetches the dist file and caches it", async () => {
    const a = await fetchBuiltinSource("node:fs");
    expect(a).toContain("/local-repo/dist/fs.js");
    const b = await fetchBuiltinSource("fs");
    expect(b).toBe(a);
    expect(calls.length).toBe(1);
  });

  test("falls back to CDN when the local dist fetch 404s", async () => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).startsWith("/local-repo/"))
        return { ok: false, status: 404 };
      return { ok: true, text: async () => "// cdn source" };
    };
    const src = await fetchBuiltinSource("node:crypto");
    expect(src).toBe("// cdn source");
    expect(calls[0]).toBe("/local-repo/dist/crypto.js");
    expect(calls[1]).toBe(_builtinBaseUrl + "crypto.js");
  });

  test("unknown specifier returns an empty-module stub without fetching", async () => {
    const src = await fetchBuiltinSource("node:not-a-real-builtin");
    expect(src).toBe("export default {}");
    expect(calls.length).toBe(0);
  });

  test("RUNTIME_ specifiers map to RUNTIME_*.js", async () => {
    // Callers pass the normalizeBuiltinSpecifier() underscore form
    // ("RUNTIME:NODE_GLOBALS" -> "RUNTIME_NODE_GLOBALS"); the colon form
    // is not a manifest key and returns the stub without fetching.
    expect(await fetchBuiltinSource("RUNTIME:NODE_GLOBALS")).toBe(
      "export default {}",
    );
    expect(calls.length).toBe(0);
    const src = await fetchBuiltinSource("RUNTIME_NODE_GLOBALS");
    expect(src).toContain("/local-repo/dist/RUNTIME_NODE_GLOBALS.js");
    expect(calls[0]).toBe("/local-repo/dist/RUNTIME_NODE_GLOBALS.js");
  });
});

describe("builtins: loadBuiltin", () => {
  test("unknown builtin returns an empty module stub", async () => {
    const mod = await loadBuiltin("node:not-a-real-builtin");
    expect(mod).toEqual({ default: {} });
  });

  test("known builtin caches the result (stub under Node, no https import)", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const a = await loadBuiltin("node:fs");
      const b = await loadBuiltin("fs");
      expect(a).toBe(b);
      expect(a.default).toBeDefined();
      expect(_builtinCache.get("fs")).toBe(a);
    } finally {
      console.warn = warn;
    }
  });
});

// ─── terminal.js ─────────────────────────────────────────────────────────────

describe("terminal: stripAnsi", () => {
  test("strips CSI color codes", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
  });

  test("strips OSC hyperlink sequences", () => {
    expect(
      stripAnsi("\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007"),
    ).toBe("link");
  });

  test("fast path: plain strings returned as-is", () => {
    const s = "no escape here";
    expect(stripAnsi(s)).toBe(s);
  });

  test("non-strings pass through untouched", () => {
    expect(stripAnsi(42)).toBe(42);
    expect(stripAnsi(null)).toBeNull();
  });
});

describe("terminal: mergeProcess", () => {
  test("user values win, defaults fill gaps", () => {
    expect(mergeProcess({ a: 1 }, { a: 0, b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test("arrays are overridden, not merged", () => {
    expect(mergeProcess({ a: [3] }, { a: [1, 2] })).toEqual({ a: [3] });
  });

  test("plain objects deep-merge", () => {
    expect(mergeProcess({ o: { x: 1 } }, { o: { x: 0, y: 2 } })).toEqual({
      o: { x: 1, y: 2 },
    });
  });
});

describe("terminal: toNodeKeypress", () => {
  function mockElement() {
    const listeners = {};
    return {
      autocomplete: "on",
      value: "typed",
      addEventListener: (t, fn) => {
        (listeners[t] = listeners[t] || []).push(fn);
      },
      cloneNode: () => ({}),
      replaceWith: () => {},
      _listeners: listeners,
      _replacedWith: null,
    };
  }

  test("throws without element or callback", () => {
    expect(() => toNodeKeypress(null, () => {})).toThrow();
    expect(() => toNodeKeypress(mockElement(), null)).toThrow();
  });

  test("keydown produces (sequence, key) like process.stdin keypress", () => {
    const el = mockElement();
    const seen = [];
    toNodeKeypress(el, (seq, key) => seen.push([seq, key]));
    el._listeners.keydown[0]({
      key: "a",
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    });
    expect(seen[0][0]).toBe("a");
    expect(seen[0][1]).toMatchObject({
      name: "a",
      ctrl: false,
      meta: false,
      shift: false,
      sequence: "a",
    });
  });

  test("special keys map to escape sequences; Enter clears the element", () => {
    const el = mockElement();
    const seen = [];
    toNodeKeypress(el, (seq, key) => seen.push([seq, key]));
    el._listeners.keydown[0]({
      key: "ArrowUp",
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    });
    expect(seen[0][0]).toBe("\x1b[A");
    el._listeners.keydown[0]({
      key: "Enter",
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    });
    expect(seen[1][0]).toBe("\n");
    expect(el.value).toBe("");
  });

  test("ctrl+key becomes a control character", () => {
    const el = mockElement();
    const seen = [];
    toNodeKeypress(el, (seq) => seen.push(seq));
    el._listeners.keydown[0]({
      key: "c",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    });
    expect(seen[0]).toBe("\x03");
  });

  test("paste fans out one callback per character", () => {
    const el = mockElement();
    const seen = [];
    toNodeKeypress(el, (seq) => seen.push(seq));
    el._listeners.paste[0]({
      clipboardData: { getData: () => "hi" },
    });
    expect(seen).toEqual(["h", "i"]);
  });

  test("stop() detaches listeners and restores autocomplete", () => {
    const el = mockElement();
    let replaced = false;
    el.replaceWith = () => {
      replaced = true;
    };
    const { stop } = toNodeKeypress(el, () => {});
    expect(el.autocomplete).toBe("off");
    stop();
    expect(replaced).toBe(true);
    expect(el.autocomplete).toBe("on");
  });
});

// ─── builtin-modules.js ──────────────────────────────────────────────────────

describe("builtin-modules: builtinModules array", () => {
  test("contains core builtins and subpath forms", () => {
    for (const name of [
      "fs",
      "fs/promises",
      "timers/promises",
      "node:sea",
      "node:sqlite",
      "node:test",
      "node:test/reporters",
      "sys",
    ])
      expect(builtinModules).toContain(name);
  });

  test("contains the private _-prefixed internals", () => {
    for (const name of [
      "_http_agent",
      "_http_client",
      "_http_common",
      "_http_incoming",
      "_http_outgoing",
      "_http_server",
      "_stream_duplex",
      "_stream_passthrough",
      "_stream_readable",
      "_stream_transform",
      "_stream_wrap",
      "_stream_writable",
      "_tls_common",
      "_tls_wrap",
    ])
      expect(builtinModules).toContain(name);
  });

  test("RUNTIME:NODE_GLOBALS is pushed (runtime.js:478 contract)", () => {
    expect(builtinModules).toContain("RUNTIME:NODE_GLOBALS");
    expect(builtinModules.length).toBeGreaterThan(100);
  });
});

// ─── transpile.js ────────────────────────────────────────────────────────────

describe("transpile: transpileTypeScript", () => {
  test("strips types, keeps ESNext module shape", () => {
    const out = transpileTypeScript(
      "const x: number = 1;\nexport function f(a: string): string { return a; }",
    );
    expect(out).toContain("const x = 1");
    expect(out).toContain("export function f(a)");
    expect(out).not.toContain(": number");
    expect(out).not.toContain(": string");
  });

  test("handles interfaces and enums", () => {
    const out = transpileTypeScript(
      "interface I { a: string }\nenum E { A, B }\nconsole.log(E.A);",
    );
    expect(out).not.toContain("interface I");
    expect(out).not.toContain("enum E");
    expect(out).toContain("console.log(E.A);");
  });
});

describe("transpile: customAcorn", () => {
  test("parses a standard ESM module", () => {
    const ast = customAcorn.parse("import x from './y';\nexport const z = 1;", {
      ecmaVersion: 2022,
      sourceType: "module",
    });
    expect(ast.type).toBe("Program");
    expect(ast.body).toHaveLength(2);
  });
});

// ─── vfs-serialize.js ────────────────────────────────────────────────────────

describe("vfs-serialize: extension helpers", () => {
  test("getExt lowercases the final extension", () => {
    expect(getExt("/a/b.CSS")).toBe("css");
    expect(getExt("/x/file.tar.gz")).toBe("gz");
    expect(getExt("noext")).toBe("noext");
  });

  test("TEXT_EXTS / BINARY_EXTS classify as runtime.js did", () => {
    expect(TEXT_EXTS.has("json")).toBe(true);
    expect(TEXT_EXTS.has("ts")).toBe(true);
    expect(BINARY_EXTS.has("wasm")).toBe(true);
    expect(BINARY_EXTS.has("png")).toBe(true);
    expect(TEXT_EXTS.has("png")).toBe(false);
  });

  test("host volume was seeded by the module init", () => {
    expect(memfsFs.vol.readFileSync("/hello.txt", "utf8")).toBe("Hello world");
  });
});

describe("vfs-serialize: serialize → deserialize round trip", () => {
  test("text, json, and binary files round-trip", () => {
    const serialized = serializeVfs(memfsFs);
    expect(typeof serialized["/hello.txt"]).toBe("string");
    // base64 of "Hello world"
    expect(serialized["/hello.txt"]).toBe(
      Buffer.from("Hello world").toString("base64"),
    );

    const out = deserializeVfs(serialized);
    expect(out["/hello.txt"]).toBe("Hello world");
    expect(out["/dir/nested.txt"]).toBe("Nested file");
  });

  test("json files deserialize to objects", () => {
    memfsFs.writeFileSync("/data.json", JSON.stringify({ a: 1 }), "utf8");
    const out = deserializeVfs(serializeVfs(memfsFs));
    expect(out["/data.json"]).toEqual({ a: 1 });
  });

  test("binary files deserialize to Uint8Array", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    memfsFs.writeFileSync("/img.png", bytes);
    const out = deserializeVfs(serializeVfs(memfsFs));
    expect(out["/img.png"]).toBeInstanceOf(Uint8Array);
    expect(Array.from(out["/img.png"])).toEqual([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
  });

  test("unknown extension: valid UTF-8 → string, invalid → bytes", () => {
    const good = { "/f.unknownext": Buffer.from("plain text").toString("base64") };
    expect(deserializeVfs(good)["/f.unknownext"]).toBe("plain text");
    const bad = {
      "/f.unknownext": Buffer.from([0xff, 0xfe, 0xfd]).toString("base64"),
    };
    expect(deserializeVfs(bad)["/f.unknownext"]).toBeInstanceOf(Uint8Array);
  });
});

describe("vfs-serialize: rehydrateVfs", () => {
  test("writes strings, bytes, and json objects into a fresh volume", async () => {
    const { Volume } = await import("memfs");
    const vol = new Volume();
    rehydrateVfs(
      {
        "/a.txt": "hello",
        "/img.png": new Uint8Array([1, 2, 3]),
        "/cfg.json": { k: "v" },
      },
      { mkdirSync: vol.mkdirSync.bind(vol), writeFileSync: vol.writeFileSync.bind(vol) },
    );
    expect(vol.readFileSync("/a.txt", "utf8")).toBe("hello");
    expect(Array.from(vol.readFileSync("/img.png"))).toEqual([1, 2, 3]);
    expect(JSON.parse(vol.readFileSync("/cfg.json", "utf8"))).toEqual({ k: "v" });
  });
});
