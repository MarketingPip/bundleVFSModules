// Regression tests for Vitest E2E gap #2: package `exports`/`imports`
// field resolution.
//
// The probe (2026-09-28, real Vitest 5.0.2) stopped at
// `Cannot find module vite ... at node_modules/vitest/dist/chunks/index.C-uw7tH9.js`
// because `vite@8.3.1` ships NO `main` — only `exports: { ".": "./dist/node/index.js", ... }`.
// `tryResolveFileOrPackage` only understood `pkg.main || 'index.js'`, so every
// exports-only package 404'd. `#` (imports-field) specifiers were likewise
// unsupported.
//
// runtime.js cannot be imported under Node (demo DOM at module scope), so —
// like tests/sync_require.test.js — these tests extract the exact shipped
// source and evaluate it.

import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);

// Extract a contiguous source block between two markers. All package-resolution
// helpers live in one block (see runtime.js), so one extraction gets everything.
function extractBlock(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1)
    throw new Error("start marker not found in runtime.js: " + startMarker);
  const end = src.indexOf(endMarker, start);
  if (end === -1)
    throw new Error("end marker not found in runtime.js: " + endMarker);
  return src.slice(start, end);
}

function loadHelpers() {
  // Block spans resolveVFS + vfsLookup + toVFSPath + the package helpers;
  // all are dependency-free within the block.
  const code = extractBlock(
    RUNTIME_SRC,
    "function resolveVFS(",
    "// --- end package exports/imports (gap #2) ---",
  );
  const factory = new Function(
    code +
      "\nreturn { resolveVFS, splitPackageSpecifier, resolvePackageTarget, resolvePackageExports, resolvePackageImports };",
  );
  return factory();
}

let H;
function helpers() {
  if (!H) H = loadHelpers();
  return H;
}

describe("splitPackageSpecifier", () => {
  test("bare package name", () => {
    expect(helpers().splitPackageSpecifier("vite")).toEqual({
      packageName: "vite",
      subpath: ".",
    });
  });
  test("package with subpath", () => {
    expect(helpers().splitPackageSpecifier("vite/dist/client")).toEqual({
      packageName: "vite",
      subpath: "./dist/client",
    });
  });
  test("scoped package with deep subpath", () => {
    expect(helpers().splitPackageSpecifier("@scope/pkg/sub/deep")).toEqual({
      packageName: "@scope/pkg",
      subpath: "./sub/deep",
    });
  });
  test("scoped package, no subpath", () => {
    expect(helpers().splitPackageSpecifier("@scope/pkg")).toEqual({
      packageName: "@scope/pkg",
      subpath: ".",
    });
  });
});

describe("resolvePackageExports (gap #2)", () => {
  test("string form — the vite@8.3.1 case", () => {
    const { resolvePackageExports } = helpers();
    expect(
      resolvePackageExports({ exports: "./dist/node/index.js" }, "."),
    ).toBe("./dist/node/index.js");
  });
  test("string form rejects subpaths", () => {
    const { resolvePackageExports } = helpers();
    expect(
      resolvePackageExports({ exports: "./dist/node/index.js" }, "./other"),
    ).toBeNull();
  });
  test("conditional object picks node condition first", () => {
    const { resolvePackageExports } = helpers();
    expect(
      resolvePackageExports(
        { exports: { ".": { node: "./node.js", default: "./default.js" } } },
        ".",
      ),
    ).toBe("./node.js");
  });
  test("exports sugar (condition-only object) resolves the main entry", () => {
    const { resolvePackageExports } = helpers();
    expect(
      resolvePackageExports(
        { exports: { import: "./esm.mjs", require: "./cjs.cjs" } },
        ".",
      ),
    ).toBe("./esm.mjs");
  });
  test("exact subpath key", () => {
    const { resolvePackageExports } = helpers();
    expect(
      resolvePackageExports(
        { exports: { ".": "./a.js", "./features": "./feat.js" } },
        "./features",
      ),
    ).toBe("./feat.js");
  });
  test("pattern key with * substitution", () => {
    const { resolvePackageExports } = helpers();
    expect(
      resolvePackageExports(
        { exports: { "./dist/*": "./src/*.js" } },
        "./dist/x",
      ),
    ).toBe("./src/x.js");
  });
  test("null target blocks the subpath", () => {
    const { resolvePackageExports } = helpers();
    expect(
      resolvePackageExports({ exports: { "./secret": null } }, "./secret"),
    ).toBeNull();
  });
  test("unlisted subpath is not exported", () => {
    const { resolvePackageExports } = helpers();
    expect(
      resolvePackageExports({ exports: { ".": "./a.js" } }, "./other"),
    ).toBeNull();
  });
  test("missing exports field", () => {
    const { resolvePackageExports } = helpers();
    expect(resolvePackageExports({ main: "./index.js" }, ".")).toBeNull();
  });
});

describe("resolvePackageImports (# specifiers)", () => {
  const vfs = {
    app: {
      "package.json": JSON.stringify({
        name: "app",
        imports: { "#alias": "./src/alias.js" },
      }),
      src: { "alias.js": "export const x = 1;" },
      "index.js": 'import "#alias";',
    },
  };
  test("resolves against the nearest package.json scope", () => {
    const { resolvePackageImports } = helpers();
    const hit = resolvePackageImports("#alias", "app/index.js", vfs);
    expect(hit).not.toBeNull();
    expect(hit.resolvedPath).toBe("/app/src/alias.js");
    expect(hit.source).toBe("export const x = 1;");
  });
  test("unlisted # specifier misses", () => {
    const { resolvePackageImports } = helpers();
    expect(resolvePackageImports("#missing", "app/index.js", vfs)).toBeNull();
  });
  test("nearest scope without imports field misses", () => {
    const { resolvePackageImports } = helpers();
    const bare = {
      app: { "package.json": JSON.stringify({ name: "app" }), "index.js": "" },
    };
    expect(resolvePackageImports("#alias", "app/index.js", bare)).toBeNull();
  });
});
