import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node.js CJS module semantics verification (Jared, 2026-09-29).
//
// In Node.js CommonJS modules:
//   - `this` at module top-level === `module.exports` (NOT globalThis)
//   - `this === globalThis` is false
//   - Setting properties on `this` sets them on module.exports, NOT as globals
//   - `__filename` and `__dirname` are available
//
// Background: the sync-require path in runtime.js uses
//   `new Function('require','module','exports','__filename','__dirname', source)`
// invoked as a plain function call. Without `.call(module.exports, ...)`,
// `this` is undefined (strict) or globalThis (sloppy) — breaking Node parity.
// The wrapCommonJS path (ESM-converted CJS) has the same issue.
//
// These tests verify the wrapper invocation pattern directly by checking
// that runtime.js invokes the wrapper with `.call(module.exports, ...)`.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);
// The sandbox template now lives in src/sandbox-template.js (built from
// src/sandbox/*.js). TEMPLATE_SRC is the decoded template value.
const TEMPLATE_SRC = JSON.parse(
  fs
    .readFileSync(
      path.join(__dirname, "..", "src", "sandbox-template.js"),
      "utf8",
    )
    .match(/export const SANDBOX_TEMPLATE = (".*");/s)[1],
);


describe("CJS `this` semantics (Node parity)", () => {
  test("sync require path invokes wrapper with this === module.exports", () => {
    // Find the wrapper invocation in createSyncRequire.
    // It should be: wrapper.call(module.exports, ...)
    // Not: wrapper(...)
    const wrapperCallWithThis = /wrapper\.call\s*\(\s*module\.exports/;

    const hasCallWithThis = wrapperCallWithThis.test(TEMPLATE_SRC);

    // The wrapper must be invoked with .call(module.exports, ...) so that
    // `this === module.exports` inside the module.
    expect(hasCallWithThis).toBe(true);
    // And NOT as a plain function call (which would make `this` undefined/globalThis).
    // Note: we check that the .call version exists; the plain call pattern
    // might still appear in comments or other contexts.
  });

  test("wrapCommonJS path invokes IIFE with this === module.exports", () => {
    // The wrapCommonJS template should use .call(module.exports, ...)
    // for the IIFE, not a plain invocation.
    const wrapCallPattern = /\.call\s*\(\s*module\.exports/;
    expect(wrapCallPattern.test(TEMPLATE_SRC)).toBe(true);
  });
});

describe("CJS __filename and __dirname", () => {
  test("__filename and __dirname are passed in sync require path", () => {
    // The sync require wrapper should receive __filename and __dirname.
    const wrapperDef =
      /new Function\(\s*['"]require['"]\s*,\s*['"]module['"]\s*,\s*['"]exports['"]\s*,\s*['"]__filename['"]\s*,\s*['"]__dirname['"]/;
    expect(wrapperDef.test(TEMPLATE_SRC)).toBe(true);
  });

  test("wrapCommonJS provides __filename and __dirname", () => {
    // Extract the wrapCommonJS function and check it defines __filename/__dirname.
    const wrapStart = TEMPLATE_SRC.indexOf("function wrapCommonJS(");
    const wrapEnd = TEMPLATE_SRC.indexOf("function importAndProxy(");
    const wrapSrc = TEMPLATE_SRC.slice(wrapStart, wrapEnd);

    // Should contain __filename and __dirname definitions.
    expect(wrapSrc).toContain("__filename");
    expect(wrapSrc).toContain("__dirname");
  });
});

describe("CJS `this` runtime behavior", () => {
  test("this === module.exports when wrapper is invoked correctly", () => {
    // Simulate the correct Node.js CJS wrapper invocation.
    const module = { exports: {} };
    const source = `
      globalThis.__testThis = this;
      globalThis.__testModuleExports = module.exports;
      this.foo = 'bar';
    `;
    const wrapper = new Function(
      "require",
      "module",
      "exports",
      "__filename",
      "__dirname",
      source,
    );
    // Correct invocation: .call(module.exports, ...)
    wrapper.call(
      module.exports,
      () => {}, // require
      module,
      module.exports,
      "/test.js",
      "/",
    );

    expect(globalThis.__testThis).toBe(module.exports);
    expect(globalThis.__testThis).not.toBe(globalThis);
    expect(module.exports.foo).toBe("bar");
    expect(globalThis.foo).toBe(undefined);

    delete globalThis.__testThis;
    delete globalThis.__testModuleExports;
    delete globalThis.foo;
  });

  test("this !== module.exports when wrapper is invoked incorrectly", () => {
    // Demonstrate the bug: plain invocation breaks `this` semantics.
    const module = { exports: {} };
    const source = `globalThis.__testThis = this;`;
    const wrapper = new Function(
      "require",
      "module",
      "exports",
      "__filename",
      "__dirname",
      source,
    );
    // Buggy invocation: plain call (current behavior)
    wrapper(() => {}, module, module.exports, "/test.js", "/");

    // `this` is NOT module.exports (it's undefined in strict mode,
    // or globalThis in sloppy mode — either way, wrong).
    expect(globalThis.__testThis).not.toBe(module.exports);

    delete globalThis.__testThis;
  });
});
