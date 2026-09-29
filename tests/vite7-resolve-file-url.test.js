// Regression test: the sandbox es-module-shims resolve hook must intercept
// `file://` URLs (and absolute VFS paths) instead of falling through to
// defaultResolve.
//
// Background (2026-09-29, vite7-browser terser integration): Vite's terser
// plugin does `await import(pathToFileURL(terserPath).href)` which produces
// `file:///node_modules/terser/dist/bundle.min.js`. The resolve hook in
// buildHtmlString (runtime.js) only special-cased Node builtins; everything
// else fell through to `defaultResolve(specifier, parentURL)`, which tried
// to actually fetch the file:// URL and threw a NetworkError.
//
// The parent-side _dynamic_import already normalizes file:// → absolute VFS
// path (commit 58d80434), but the sandbox-side resolve hook never routed
// file:// specifiers there — it only called the interop for builtins.
//
// The platform fix (AGENTS.md rule 6): the resolve hook must detect file://
// URLs (and absolute VFS paths), normalize them, and route them through the
// same _dynamic_import + _build_file interop as builtins. Any file:// import
// was broken, not just Vite's terser path.

import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);

// Extract the resolve hook body from buildHtmlString: from the
// `resolve: async (specifier, parentURL, defaultResolve) => {` line to the
// `return defaultResolve(specifier, parentURL);` fallthrough.
function getResolveHook() {
  const start = RUNTIME_SRC.indexOf(
    "resolve: async (specifier, parentURL, defaultResolve) => {",
  );
  expect(start).toBeGreaterThan(0);
  const end = RUNTIME_SRC.indexOf(
    "return defaultResolve(specifier, parentURL);",
    start,
  );
  expect(end).toBeGreaterThan(start);
  return RUNTIME_SRC.slice(start, end);
}

describe("es-module-shims resolve hook file:// interception", () => {
  test("hook detects file:// specifiers before the defaultResolve fallthrough", () => {
    const hook = getResolveHook();
    // The hook must branch on file:// URLs — otherwise they hit
    // defaultResolve and die with a NetworkError.
    expect(hook).toMatch(/specifier\.startsWith\(["']file:\/\//);
  });

  test("hook detects absolute VFS paths before the defaultResolve fallthrough", () => {
    const hook = getResolveHook();
    // Absolute VFS paths (/node_modules/...) are not fetchable URLs either.
    expect(hook).toMatch(/specifier\.startsWith\(["']\/["']\)/);
  });

  test("file:// branch routes through the _dynamic_import interop", () => {
    const hook = getResolveHook();
    // Find the file:// branch and verify it calls the parent interop
    // (the same _dynamic_import + _build_file path the builtin branch uses),
    // not defaultResolve.
    const fileIdx = hook.search(/specifier\.startsWith\(["']file:\/\//);
    expect(fileIdx).toBeGreaterThan(0);
    const branch = hook.slice(fileIdx, fileIdx + 4500);
    expect(branch).toMatch(/callParent\(\s*['"]_dynamic_import['"]/);
    expect(branch).toMatch(/callParent\(\s*['"]_build_file['"]/);
  });

  test("file:// branch returns a data: URL (never falls through)", () => {
    const hook = getResolveHook();
    const fileIdx = hook.search(/specifier\.startsWith\(["']file:\/\//);
    const branch = hook.slice(fileIdx, fileIdx + 4500);
    expect(branch).toMatch(/data:text\/javascript/);
  });
});
