import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression tests: TypeScript's __exportStar CJS pattern must survive the
// CJS→ESM transform.
//
// Background (2026-09-29, vite7-browser M4): real Vitest 5.0.2 loads in the
// browser, but `vitest` re-exports `expectTypeOf` from the `expect-type`
// package, whose dist/index.js is TypeScript-compiled CJS using:
//   __exportStar(require("./branding"), exports);
// The sandbox's convertCjsToEsm did not handle __exportStar at all, and
// additionally the `exports.expectTypeOf = void 0` placeholder + later
// `exports.expectTypeOf = expectTypeOf` produced a duplicate
// `export const expectTypeOf` → SyntaxError.
//
// runtime.js cannot be imported under Node (it wires a demo DOM at module
// scope), so — like the other vite7 tests — these tests extract the exact
// shipped functions and evaluate them.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);
const SANDBOX_SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "sandbox", "21-sync-require.js"),
  "utf8",
);

function extractFunction(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("function not found: " + name);
  let fnStart = start;
  const before = src.slice(Math.max(0, start - 8), start);
  if (before.endsWith("export ")) fnStart = start - 7;
  let p = src.indexOf("(", start);
  let pdepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === "(") pdepth++;
    else if (src[p] === ")") {
      pdepth--;
      if (pdepth === 0) break;
    }
  }
  let i = src.indexOf("{", p);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        return src.slice(fnStart, i + 1);
      }
    }
  }
  throw new Error("unbalanced braces for " + name);
}

const convertSrc = extractFunction(RUNTIME_SRC, "convertCjsToEsm").replace(
  /^export\s+/,
  "",
);
const transformSrc = extractFunction(
  RUNTIME_SRC,
  "transformImportsToLoadModule",
).replace(/^export\s+/, "");
const buildProxySrc = extractFunction(SANDBOX_SRC, "buildModuleProxy");

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const acorn = require("acorn");
const MagicString = require("magic-string").default || require("magic-string");
const walk = require("acorn-walk");

const convertCjsToEsm = new Function(
  "acorn",
  "MagicString",
  "walk",
  `${convertSrc}; return convertCjsToEsm;`,
)(acorn, MagicString, walk);

// transformImportsToLoadModule references generateImportBinding (defined
// after it in runtime.js); extract that too.
const genBindingSrc = extractFunction(RUNTIME_SRC, "generateImportBinding");
const transformImportsToLoadModule = new Function(
  "acorn",
  "MagicString",
  "walk",
  `${genBindingSrc}; ${transformSrc}; return transformImportsToLoadModule;`,
)(acorn, MagicString, walk);

const buildModuleProxy = new Function(
  `${buildProxySrc}; return buildModuleProxy;`,
)();

// --- Mini sandbox pipeline ----------------------------------------------
// Mirrors the real _build_file order: convertCjsToEsm (CJS→ESM) then
// transformImportsToLoadModule (import/require/export* → loadModule).
// `files` maps absolute path → CJS source. The mock loadModule resolves
// relative specifiers against the importing file's directory.
async function loadViaPipeline(files, entryPath) {
  const UUID = "test";
  const converted = {};
  for (const [p, src] of Object.entries(files)) {
    converted[p] = convertCjsToEsm(src, { filename: p }).code;
  }

  function resolveSpec(fromPath, spec) {
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const dir = fromPath.slice(0, fromPath.lastIndexOf("/"));
      const parts = (dir + "/" + spec).split("/");
      const out = [];
      for (const part of parts) {
        if (part === "." || part === "") continue;
        if (part === "..") out.pop();
        else out.push(part);
      }
      return "/" + out.join("/");
    }
    return spec;
  }

  const moduleCache = new Map();
  async function mockLoadModule(specifier, _type, entryPoint) {
    let resolved = resolveSpec(entryPoint || entryPath, specifier);
    // Extension probing (mirrors the real loader's .js fallback).
    if (!converted[resolved] && converted[resolved + ".js"]) {
      resolved = resolved + ".js";
    }
    if (moduleCache.has(resolved)) return moduleCache.get(resolved);
    if (!converted[resolved]) {
      throw new Error(
        `[ERR_MODULE_NOT_FOUND]: Cannot find module ${specifier}`,
      );
    }
    const { code } = transformImportsToLoadModule(
      UUID,
      converted[resolved],
      resolved,
      entryPath,
      {},
    );
    const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
    const ns = await import(url);
    moduleCache.set(resolved, ns);
    return ns;
  }

  globalThis[`_RUNTIME${UUID}_`] = { loadModule: mockLoadModule };
  try {
    const { code } = transformImportsToLoadModule(
      UUID,
      converted[entryPath],
      entryPath,
      entryPath,
      {},
    );
    const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
    const data = await import(url);
    return buildModuleProxy(data, entryPath, entryPath, "import");
  } finally {
    delete globalThis[`_RUNTIME${UUID}_`];
  }
}

// --- Fixtures ------------------------------------------------------------

const DEP_CJS = `
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.depFn = () => "dep";
exports.depVal = 42;
`;

const MAIN_CJS = `
"use strict";
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) {
        exports[p] = m[p];
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mainFn = void 0;
__exportStar(require("./dep"), exports);
const mainFn = () => "main";
exports.mainFn = mainFn;
`;

describe("__exportStar CJS→ESM transform", () => {
  test("__exportStar call becomes export * from", () => {
    const { code } = convertCjsToEsm(MAIN_CJS, { filename: "/main.js" });
    expect(code).toMatch(/export\s*\*\s*from\s*["']\.\/dep["']/);
    expect(code).not.toMatch(/__exportStar\(require/);
  });

  test("void-0 placeholder does not produce duplicate exports", async () => {
    const { code } = convertCjsToEsm(MAIN_CJS, { filename: "/main.js" });
    // Must parse as valid ESM (duplicate `export const mainFn` would throw
    // "Identifier 'mainFn' has already been declared").
    expect(() =>
      acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" }),
    ).not.toThrow();
    // Exactly one export binding for mainFn.
    const matches =
      code.match(/export\s+(const\s+mainFn|\{\s*mainFn\s*\})/g) || [];
    expect(matches.length).toBe(1);
  });

  test("star-exported bindings resolve through the pipeline", async () => {
    const mod = await loadViaPipeline(
      { "/dep.js": DEP_CJS, "/main.js": MAIN_CJS },
      "/main.js",
    );
    expect(mod.mainFn()).toBe("main");
    expect(mod.depFn()).toBe("dep");
    expect(mod.depVal).toBe(42);
  });

  test("star export skips default", async () => {
    const depWithDefault = `
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.named = "yes";
module.exports = { named: "yes", extra: true };
`;
    const mainStar = `
"use strict";
var __exportStar = function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) exports[p] = m[p];
};
__exportStar(require("./dep2"), exports);
exports.own = "mine";
`;
    const mod = await loadViaPipeline(
      { "/dep2.js": depWithDefault, "/main2.js": mainStar },
      "/main2.js",
    );
    // ESM 'export *' does not re-export 'default'; dep2's module.exports
    // became a default export, so 'named' is not star-re-exported.
    expect(mod.named).toBeUndefined();
    expect(mod.own).toBe("mine");
  });
});

describe("real expect-type package", () => {
  test("transforms without SyntaxError and exposes expectTypeOf", async () => {
    const etPath = "/node_modules/expect-type/dist/index.js";
    const etSrc = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "node_modules",
        "expect-type",
        "dist",
        "index.js",
      ),
      "utf8",
    );
    const files = { [etPath]: etSrc };
    // Include the (empty-export) sibling modules so __exportStar targets resolve.
    for (const sub of ["branding", "messages", "overloads", "utils"]) {
      const subPath = `/node_modules/expect-type/dist/${sub}.js`;
      files[subPath] = fs.readFileSync(
        path.join(
          __dirname,
          "..",
          "node_modules",
          "expect-type",
          "dist",
          `${sub}.js`,
        ),
        "utf8",
      );
    }
    const mod = await loadViaPipeline(files, etPath);
    expect(typeof mod.expectTypeOf).toBe("function");
    // The type-level assertion function is callable at runtime (returns an object).
    expect(typeof mod.expectTypeOf({})).toBe("object");
  });
});
