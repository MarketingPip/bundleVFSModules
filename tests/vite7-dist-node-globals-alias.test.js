/**
 * vite7-dist-node-globals-alias.test.js
 *
 * Regression test for the M3 `global is not defined` failure
 * (2026-09-30-vite7-browser-blocker, phase 3).
 *
 * Root cause: dist/RUNTIME_NODE_GLOBALS.js was a STALE bundle (built
 * 2026-09-29) that predates the `globalThis.global = globalThis` alias in
 * src/node_globals.js. The sandbox loads RUNTIME:NODE_GLOBALS from that dist
 * bundle at startup, so the alias was never installed and vite's bundled
 * isexe (`global.TESTING_WINDOWS` in chunks/config.js) threw
 * ReferenceError: global is not defined. The runtime.js template's own alias
 * hunk sits inside the defineProperty(window,'process') try block, which
 * throws in the M3 sandbox realm — so it was skipped too.
 *
 * This test pins the dist bundle to the alias: importing it must install
 * `global` as an alias of globalThis when missing.
 */
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";

describe("dist/RUNTIME_NODE_GLOBALS.js installs the `global` alias", () => {
  let saved;
  beforeEach(() => {
    saved = globalThis.global;
    vi.resetModules();
  });
  afterEach(() => {
    if (saved === undefined) delete globalThis.global;
    else globalThis.global = saved;
  });

  test("missing `global` is installed as an alias of globalThis", async () => {
    delete globalThis.global;
    expect(typeof globalThis.global).toBe("undefined");
    await import("../dist/RUNTIME_NODE_GLOBALS.js");
    expect(globalThis.global).toBe(globalThis);
  });

  test("existing `global` is never overwritten", async () => {
    const sentinel = Object.create(globalThis);
    sentinel.__test_marker__ = true;
    globalThis.global = sentinel;
    await import("../dist/RUNTIME_NODE_GLOBALS.js");
    expect(globalThis.global).toBe(sentinel);
  });
});
