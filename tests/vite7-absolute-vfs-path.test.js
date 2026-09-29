// Regression test: loadModule must recognize absolute VFS paths.
//
// Background (2026-09-29, vite7-browser terser evaluation): importing
// terser via an absolute VFS path (e.g. `/node_modules/terser/main.js` or
// `/node_modules/terser/dist/bundle.min.js`) failed with
// `[ERR_MODULE_NOT_FOUND]: Cannot find module /node_modules/...` because
// loadModule classified the path as a bare specifier instead of an
// absolute path.
//
// Root cause: `const isAbsolute = modulePath.startsWith('./')` — a copy/
// paste of the isRelative check. Absolute VFS paths start with `/`, not
// `./`. The misclassification sent `/node_modules/...` down the bare-
// specifier branch (resolveNodeModule), which split it into packageName=""
// and failed.
//
// Vite's terser plugin does `await import(pathToFileURL(terserPath).href)`
// which produces `file:///node_modules/...` URLs. These must also be
// recognized as absolute VFS paths (strip the `file://` scheme).
//
// The platform fix: isAbsolute must check for a leading `/` or `file://`.
// This is a platform bug, not a library-specific workaround (AGENTS.md rule 6):
// any absolute VFS path import was broken, not just terser's.

import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);

describe("loadModule absolute VFS path classification", () => {
  test("isAbsolute checks for leading '/' (not './')", () => {
    // Find the isAbsolute assignment in loadModule. There is also a
    // correct '/'-check in the sync-require path (line ~5081); we target
    // the loadModule one which had the './' bug.
    const matches = [
      ...RUNTIME_SRC.matchAll(
        /const isAbsolute = modulePath\.startsWith\(([^)]+)\)/g,
      ),
    ];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      // Every isAbsolute classification must use '/' — './' is isRelative's job.
      expect(m[1].trim()).toBe("'/'");
    }
  });

  test("file:// URLs are normalized to absolute VFS paths", () => {
    // Vite's terser plugin does `await import(pathToFileURL(p).href)` which
    // produces `file:///node_modules/...`. The sandbox must strip the scheme
    // and treat it as an absolute VFS path (not a network URL).
    const hasFileHandling =
      RUNTIME_SRC.includes('startsWith("file://")') ||
      RUNTIME_SRC.includes("startsWith('file://')");
    expect(hasFileHandling).toBe(true);
  });

  test("absolute VFS path takes the relative/interop branch, not bare-specifier", () => {
    // The branch condition must include isAbsolute so '/x/y.js' goes
    // through the VFS lookup instead of resolveNodeModule.
    const condPattern =
      /if\s*\(\s*isRelative\s*\|\|\s*isNodeBuiltIn\s*\|\|\s*isAbsolute/;
    expect(RUNTIME_SRC).toMatch(condPattern);
  });
});

describe("_dynamic_import absolute VFS path handling", () => {
  test("handler distinguishes absolute paths from bare specifiers", () => {
    // The _dynamic_import interop handler (registered via registerInterop)
    // must not send '/node_modules/...' down the bare-specifier
    // (resolveNodeModule) branch. Look for the isAbsolute definition in
    // the handler's scope: it follows the "2. Determine the importer's
    // VFS path" comment and precedes the "3a. Package-internal" comment.
    const handlerSection = RUNTIME_SRC.match(
      /\/\/ 2\. Determine the importer's VFS path[\s\S]{0,500}?const isRelative = path\.startsWith\("\.\/"\) \|\| path\.startsWith\("\.\.\/"\);([\s\S]{0,200}?)\/\/ 3a\./,
    );
    expect(handlerSection).not.toBeNull();
    // The isAbsolute check must exist between isRelative and the # handling
    expect(handlerSection[1]).toMatch(
      /const isAbsolute = path\.startsWith\("\/"\)/,
    );
  });

  test("absolute paths bypass the bare-specifier branch", () => {
    // The bare-specifier branch in the REAL _dynamic_import handler must
    // exclude absolute paths: `if (!isRelative && !isAbsolute)`.
    // (The demo handler at ~8639 still uses `if (!isRelative)` — that's fine,
    // it's a minimal fixture, not the production path.)
    //
    // Find the real handler by its unique "Absolute VFS paths" comment.
    const idx = RUNTIME_SRC.indexOf(
      "// Absolute VFS paths (isAbsolute) bypass this branch",
    );
    expect(idx).toBeGreaterThan(0);
    const section = RUNTIME_SRC.slice(idx, idx + 500);
    const m = section.match(/if\s*\(([^)]+)\)/);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/!isRelative\s*&&\s*!isAbsolute/);
  });
});
