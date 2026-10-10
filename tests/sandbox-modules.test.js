import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodeTransformer } from "../src/runtime/code-transformer.js";
import {
  __parseStackLocationFn,
  SandboxRuntime,
} from "../src/runtime/sandbox-runtime.js";

// Tests for the Worker E ("sandbox") extraction: src/runtime/code-sandbox.js,
// src/runtime/sandbox-runtime.js, src/runtime/code-transformer.js.
//
// code-transformer.js and sandbox-runtime.js import cleanly under Node.
// code-sandbox.js targets the browser host (esm.sh specifiers + document),
// so — like tests/runtime_error_stacks.test.js does for runtime.js — it is
// loaded by evaluating its exact shipped source with stubbed imports and
// stubbed runtime.js-scope globals (the bare identifiers the integration
// step will later turn into imports).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs
  .readFileSync(path.join(__dirname, "..", "runtime.js"), "utf8")
  .split("\n");
const BANNER = "// " + "=".repeat(76);

// ---------------------------------------------------------------------------
// code-sandbox.js loader (extract + evaluate)
// ---------------------------------------------------------------------------

const IMPORT_STUB_NAMES = [
  "uuid",
  "TraceMap",
  "originalPositionFor",
  "remapping",
  "applyTransformPlugins",
  "applyResolvePlugins",
  "applyLoadPlugins",
  "dispatchLoader",
  "validatePlugin",
  "getPlugins",
  "lookupNativeInterception",
];

class StubEmitter {
  constructor() {
    this.emitted = [];
  }
  on() {
    return this;
  }
  emit(ev, data) {
    this.emitted.push([ev, data]);
    return true;
  }
}

// Bare identifiers that are still module scope in runtime.js (kept as-is in
// the extraction, per the sibling-module convention).
const RUNTIME_SCOPE_STUBS = {
  EventEmitter: StubEmitter,
  ImportResolver: class ImportResolver {
    constructor(opts) {
      this.opts = opts;
    }
  },
  ExecutionContext: class ExecutionContext {},
  mergeProcess: (user, defaults) => ({ ...defaults, ...user }),
  SyntaxChecker: class SyntaxChecker {
    check() {}
  },
  convertEsmToCjs: (s) => ({ code: s }),
  convertCjsToEsm: (s) => ({ code: s }),
  detectModuleSystem: () => ({ isCJS: false, isESM: true }),
  replaceGlobalThisVar: (s) => ({ code: s }),
  transformImportsToLoadModule: () => ({ code: "", map: null }),
  flattenFileTree: (o) => o || {},
  normalizeSeaAssets: (a) => a || {},
  formatErrors: (code, err) => err,
  loadBuiltin: async () => ({}),
  fetchBuiltinSource: async () => "",
  isViteBrowserInterceptionActive: () => false,
};

function loadCodeSandbox() {
  const fileSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "runtime", "code-sandbox.js"),
    "utf8",
  );
  // Drop the static imports (esm.sh / ../plugins.* are not resolvable under
  // Node); the stubbed names are injected as function parameters instead.
  const noImports = fileSrc.replace(
    /^import[\s\S]*?from\s*(?:"[^"]*"|'[^']*');/gm,
    "",
  );
  if (/^import /m.test(noImports))
    throw new Error("unremoved import in code-sandbox.js");
  const noExports = noImports.replace(/^export /gm, "");
  const factory = new Function(
    ...IMPORT_STUB_NAMES,
    noExports + "\nreturn { CodeSandbox };",
  );
  return factory(
    () => "test-uuid-1", // uuid
    class TraceMap {}, // TraceMap
    () => null, // originalPositionFor
    () => ({}), // remapping
    async (s) => s, // applyTransformPlugins
    async () => null, // applyResolvePlugins
    async () => ({ contents: "", loader: "js" }), // applyLoadPlugins
    (c) => ({ kind: "module", source: c }), // dispatchLoader
    () => true, // validatePlugin
    () => [], // getPlugins
    () => null, // lookupNativeInterception
  );
}

let sandboxMod;
const savedGlobals = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(RUNTIME_SCOPE_STUBS)) {
    savedGlobals[k] = globalThis[k];
    globalThis[k] = v;
  }
  sandboxMod = loadCodeSandbox();
});
afterAll(() => {
  for (const k of Object.keys(RUNTIME_SCOPE_STUBS)) {
    if (savedGlobals[k] === undefined) delete globalThis[k];
    else globalThis[k] = savedGlobals[k];
  }
});

// ---------------------------------------------------------------------------
// Byte-exactness: extracted bodies must match runtime.js verbatim
// (modulo the added `export` keywords).
//
// runtime.js is GENERATED (src/build-runtime.mjs) — hardcoded monolith line
// ranges cannot match it. Each module's section is located by its build
// banner (`// ── src/runtime/<name> ──`) instead, and runs to the next
// section banner (or EOF).
// ---------------------------------------------------------------------------

function moduleBody(relPath, firstLine) {
  const src = fs.readFileSync(path.join(__dirname, "..", relPath), "utf8");
  const idx = src.indexOf(firstLine);
  if (idx === -1) throw new Error(`body start not found in ${relPath}`);
  return src
    .slice(idx)
    .replace(/^export /gm, "")
    .replace(/\n+$/, "");
}

function runtimeSection(moduleName, firstLine) {
  const banner = `// ── src/runtime/${moduleName} ──`;
  const startIdx = RUNTIME_SRC.findIndex((l) => l.startsWith(banner));
  if (startIdx === -1)
    throw new Error(`section banner not found in runtime.js: ${banner}`);
  let endIdx = RUNTIME_SRC.findIndex(
    (l, i) => i > startIdx && l.startsWith("// ── src/runtime/"),
  );
  if (endIdx === -1) endIdx = RUNTIME_SRC.length;
  const section = RUNTIME_SRC.slice(startIdx, endIdx).join("\n");
  const idx = section.indexOf(firstLine);
  if (idx === -1)
    throw new Error(
      `body start not found in runtime.js section: ${moduleName}`,
    );
  return section
    .slice(idx)
    .replace(/^export /gm, "")
    .replace(/\n+$/, "");
}

describe("extraction fidelity (byte-exact vs runtime.js)", () => {
  test("code-transformer.js matches its runtime.js section", () => {
    expect(moduleBody("src/runtime/code-transformer.js", BANNER)).toBe(
      runtimeSection("code-transformer.js", BANNER),
    );
  });
  test("sandbox-runtime.js matches its runtime.js section", () => {
    expect(
      moduleBody(
        "src/runtime/sandbox-runtime.js",
        "// Parse one V8 stack-frame line",
      ),
    ).toBe(
      runtimeSection("sandbox-runtime.js", "// Parse one V8 stack-frame line"),
    );
  });
  test("code-sandbox.js matches its runtime.js section", () => {
    // NOTE: executeCode / createSandbox live in src/runtime/entry.js
    // (Worker F's section) — intentionally not duplicated in code-sandbox.js.
    expect(moduleBody("src/runtime/code-sandbox.js", BANNER)).toBe(
      runtimeSection("code-sandbox.js", BANNER),
    );
  });
});

// ---------------------------------------------------------------------------
// CodeTransformer (pure — direct import)
// ---------------------------------------------------------------------------

describe("CodeTransformer", () => {
  test("is an exported class", () => {
    expect(typeof CodeTransformer).toBe("function");
  });
  test("transform applies transformers in order", () => {
    expect(
      CodeTransformer.transform("a", [(s) => s + "b", (s) => s + "c"]),
    ).toBe("abc");
  });
  test("transform swallows transformer errors and keeps prior result", () => {
    expect(
      CodeTransformer.transform("ok", [
        () => {
          throw new Error("boom");
        },
      ]),
    ).toBe("ok");
  });
  test("removeConsole strips console statements", () => {
    const out = CodeTransformer.transformers.removeConsole(
      'console.log("hi");\nfoo();',
    );
    expect(out).not.toContain("console.log");
    expect(out).toContain("foo();");
  });
  test("wrapAsync wraps bare code and leaves IIFEs alone", () => {
    expect(CodeTransformer.transformers.wrapAsync("let x = 1;")).toContain(
      "(async () => {",
    );
    const iife = "(async () => {\nlet x = 1;\n})();";
    expect(CodeTransformer.transformers.wrapAsync(iife)).toBe(iife);
  });
  test("addStrictMode prepends the directive", () => {
    expect(CodeTransformer.transformers.addStrictMode("x();")).toBe(
      "'use strict';\nx();",
    );
  });
});

// ---------------------------------------------------------------------------
// __parseStackLocationFn + SandboxRuntime (direct import)
// ---------------------------------------------------------------------------

describe("__parseStackLocationFn (module copy)", () => {
  test('parses "at fn (https://host/app.js:10:15)"', () => {
    expect(
      __parseStackLocationFn("    at myFn (https://example.com/app.js:10:15)"),
    ).toEqual({ file: "https://example.com/app.js", line: 10, column: 15 });
  });
  test("parses data: URL frames as one unit", () => {
    // Realistic V8 form: the :line:column trailer sits inside the parens,
    // appended to the data: URL (inner colons are %-encoded per the impl).
    expect(
      __parseStackLocationFn(
        "    at foo (data:text/javascript;base64,QUJD:3:7)",
      ),
    ).toEqual({
      file: "data:text/javascript;base64,QUJD",
      line: 3,
      column: 7,
    });
  });
  test("returns null for unparseable frames", () => {
    expect(__parseStackLocationFn("    at someNativeThing")).toBeNull();
    expect(__parseStackLocationFn("")).toBeNull();
  });
});

describe("SandboxRuntime.generate", () => {
  const stubs = {
    normalizeBuiltinSpecifier: (s) => s,
    stripAnsi: (s) => s,
    _builtinManifest: { fs: "dist/fs.js" },
    builtinModules: ["fs"],
  };
  const saved = {};
  beforeAll(() => {
    for (const [k, v] of Object.entries(stubs)) {
      saved[k] = globalThis[k];
      globalThis[k] = v;
    }
  });
  afterAll(() => {
    for (const k of Object.keys(stubs)) {
      if (saved[k] === undefined) delete globalThis[k];
      else globalThis[k] = saved[k];
    }
  });

  const baseConfig = {
    uuid: "abc123",
    interopVariable: "interop",
    process: { title: "node" },
    fs: {},
    seaAssets: {},
    fileName: "index.js",
    imports: ["import x from './x.js';"],
  };

  test("substitutes every token and leaves no %%TOKEN%% behind", () => {
    const out = SandboxRuntime.generate("console.log(1)", baseConfig);
    expect(out).toContain("console.log(1)");
    expect(out).toContain("abc123");
    expect(out).toContain("index.js");
    expect(out).toContain("import x from './x.js';");
    expect(out).not.toMatch(/%%[A-Z_]+%%/);
  });
  test("inlines __parseStackLocationFn source", () => {
    const out = SandboxRuntime.generate("", baseConfig);
    expect(out).toContain(__parseStackLocationFn.toString().slice(0, 60));
  });
  test("serializes a BYO shell function", () => {
    function myShell(cmd) {
      return cmd;
    }
    const out = SandboxRuntime.generate("", { ...baseConfig, shell: myShell });
    expect(out).toContain("__SHELL__");
    expect(out).toContain("function myShell(cmd)");
  });
  test("omits the shell field when no shell is provided", () => {
    const out = SandboxRuntime.generate("", baseConfig);
    expect(out).not.toContain("__SHELL__");
  });
});

// ---------------------------------------------------------------------------
// CodeSandbox (evaluated with stubs)
// ---------------------------------------------------------------------------

describe("CodeSandbox (module loads and instantiates)", () => {
  test("exports the CodeSandbox class", () => {
    // executeCode / createSandbox live in Worker F's src/runtime/entry.js.
    expect(typeof sandboxMod.CodeSandbox).toBe("function");
  });

  test("instantiates with defaults", () => {
    const sb = new sandboxMod.CodeSandbox();
    expect(sb.uuid).toMatch(/^_u_/);
    expect(sb.config.timeout).toBe(30000);
    expect(sb.config.fileName).toBe("index.js");
    expect(sb.config.interopVariable).toBe("interop");
    expect(sb.initialized).toBe(false);
    expect(sb.executionCount).toBe(0);
    expect(sb.interopHandlers).toEqual({});
    expect(sb instanceof StubEmitter).toBe(true);
  });

  test("constructor rejects a non-function shell option", () => {
    expect(() => new sandboxMod.CodeSandbox({ shell: "nope" })).toThrow(
      TypeError,
    );
  });

  test("constructor validates the plugins option", () => {
    expect(() => new sandboxMod.CodeSandbox({ plugins: {} })).toThrow(
      TypeError,
    );
    expect(
      () =>
        new sandboxMod.CodeSandbox({
          plugins: [
            { name: "dup", transform: () => {} },
            { name: "dup", transform: () => {} },
          ],
        }),
    ).toThrow(/Duplicate plugin name/);
  });

  test("init emits 'initialized' and is idempotent", async () => {
    const sb = new sandboxMod.CodeSandbox();
    await sb.init();
    expect(sb.initialized).toBe(true);
    expect(sb.emitted.map(([e]) => e)).toContain("initialized");
    await sb.init(); // second call is a no-op
    expect(sb.emitted.filter(([e]) => e === "initialized")).toHaveLength(1);
  });

  test("registerInterop / unregisterInterop round-trip and chain", () => {
    const sb = new sandboxMod.CodeSandbox();
    const handler = async () => 42;
    expect(sb.registerInterop("answer", handler)).toBe(sb);
    expect(sb.interopHandlers.answer).toBe(handler);
    expect(sb.unregisterInterop("answer")).toBe(sb);
    expect("answer" in sb.interopHandlers).toBe(false);
  });

  test("kill returns false when the sandbox is not running", () => {
    const sb = new sandboxMod.CodeSandbox();
    expect(sb.kill()).toBe(false);
  });
});

describe("CodeSandbox._mapStackFrames", () => {
  test("returns [] for non-array input", () => {
    const sb = new sandboxMod.CodeSandbox();
    expect(sb._mapStackFrames(null)).toEqual([]);
    expect(sb._mapStackFrames("nope")).toEqual([]);
  });

  test("marks frames with no registry entry as internal", () => {
    const sb = new sandboxMod.CodeSandbox();
    const frames = [{ file: "https://cdn/x.js", line: 10, column: 5 }];
    expect(sb._mapStackFrames(frames, "")).toEqual([
      {
        file: "https://cdn/x.js",
        line: 10,
        column: 5,
        internal: true,
        source: "https://cdn/x.js",
      },
    ]);
  });
});

describe("CodeSandbox._formatMappedError", () => {
  test("renders a code frame for the first non-internal frame", () => {
    const sb = new sandboxMod.CodeSandbox();
    sb._sourceMapRegistry.set("k", {
      originalSource: "l1\nl2\nl3\nl4\nl5",
      filename: "index.js",
    });
    const out = sb._formatMappedError("TypeError", "boom", [
      { file: "index.js", line: 3, column: 5, internal: false, source: "k" },
    ]);
    expect(out).toContain("TypeError: boom");
    expect(out).toContain("at (index.js:3:5)");
    expect(out).toContain("→"); // error-line marker
    expect(out).toContain("l3");
  });

  test("falls back to a plain frame list when nothing is internal=false", () => {
    const sb = new sandboxMod.CodeSandbox();
    const out = sb._formatMappedError("Error", "bad", [
      { file: "a.js", line: 1, column: 2, internal: true, source: "a.js" },
    ]);
    expect(out).toContain("Error: bad");
    expect(out).not.toContain("→");
  });
});
