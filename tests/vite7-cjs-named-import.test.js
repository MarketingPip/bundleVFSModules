import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression tests: ESM named imports from CJS modules must resolve
// against module.exports (Node ESM-CJS interop parity).
//
// Background (2026-09-29, vite7-browser M3): booting real vite@7 in the
// browser died with:
//   The requested module 'esbuild' does not provide an export named 'build'
// Vite's chunks do `import { build } from "esbuild"`. Our esbuild
// interception serves a CJS shim (module.exports = { ..., build, ... }).
// The host's convertCjsToEsm rewrites that to `export default {...}` with
// no named exports, and the sandbox's buildModuleProxy threw on any named
// access instead of falling back to the CJS exports object, the way Node
// does (cjs-module-lexer static named exports).
//
// The general mechanism (Node semantics): for a CJS module, named ESM
// imports resolve against module.exports. The interop must not require
// every CJS dependency to be rewritten as ESM.
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
  // Include a leading `export ` if present (runtime.js uses
  // `export function`); callers strip it as needed.
  let fnStart = start;
  const before = src.slice(Math.max(0, start - 8), start);
  if (before.endsWith("export ")) fnStart = start - 7;
  // Skip the parameter list (it may contain {} default values) before
  // looking for the function body's opening brace.
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

// convertCjsToEsm is `export function` in runtime.js; strip the export
// keyword and provide its imports (acorn, MagicString, walk).
const convertSrc = extractFunction(RUNTIME_SRC, "convertCjsToEsm").replace(
  /^export\s+/,
  "",
);
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
const buildModuleProxy = new Function(
  `${buildProxySrc}; return buildModuleProxy;`,
)();

// Mirror of src/vendor/esbuild-shim.cjs's export shape: a plain object
// literal with a spread plus named function keys.
const CJS_SHIM_LIKE = `
"use strict";
function gated(fn) { return function (...args) { return fn(...args); }; }
const vendor = { version: "0.28.2", build: function () { return "real-build"; } };
module.exports = {
  ...vendor,
  transform: gated(vendor.build),
  build: gated(vendor.build),
};
`;

async function loadCjsAsEsm(cjsSource, displayName = "esbuild") {
  const { code } = convertCjsToEsm(cjsSource, {
    filename: "/node_modules/.bvm/fake-shim.cjs",
  });
  const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
  const data = await import(url);
  return buildModuleProxy(
    data,
    "/node_modules/.bvm/fake-shim.cjs",
    displayName,
    "import",
  );
}

describe("ESM named imports from CJS modules (Node interop parity)", () => {
  test("named import resolves against module.exports", async () => {
    const mod = await loadCjsAsEsm(CJS_SHIM_LIKE);
    expect(typeof mod.build).toBe("function");
    expect(mod.build()).toBe("real-build");
  });

  test("spread-inherited keys are visible as named imports", async () => {
    const mod = await loadCjsAsEsm(CJS_SHIM_LIKE);
    expect(mod.version).toBe("0.28.2");
    expect(typeof mod.transform).toBe("function");
  });

  test("default import still returns the CJS exports object", async () => {
    const mod = await loadCjsAsEsm(CJS_SHIM_LIKE);
    expect(typeof mod.default.build).toBe("function");
  });

  test("missing named export still throws SyntaxError", async () => {
    const mod = await loadCjsAsEsm(CJS_SHIM_LIKE);
    expect(() => mod.nope).toThrow(SyntaxError);
    expect(() => mod.nope).toThrow("does not provide an export named 'nope'");
  });

  test("real ESM modules do NOT fall back to default-export keys", async () => {
    const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(
      `export const a = 1; export default { a: 1, b: 2 };`,
    )}`;
    const data = await import(url);
    const mod = buildModuleProxy(data, "/x/real-esm.js", "real-esm", "import");
    expect(mod.a).toBe(1);
    // Node parity: `b` is not a named export of the ESM module, even
    // though the default export object has a `b` key.
    expect(() => mod.b).toThrow(SyntaxError);
  });
});
