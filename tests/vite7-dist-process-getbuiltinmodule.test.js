/**
 * vite7-dist-process-getbuiltinmodule.test.js
 *
 * Regression test for the M3 `Cannot find module 'path'` failure
 * (2026-09-30-vite7-browser-blocker, phase 2).
 *
 * Root cause: dist/process.js was a STALE bundle (built 2026-09-29) whose
 * getBuiltinModule was a no-op stub returning undefined for every string id.
 * src/process.js (2026-09-30) delegates to the sandbox template's authoritative
 * process (globalThis.__bvm_process_final__), which reads the preload-filled
 * sync builtin cache. dist/ was never rebuilt, so every sync builtin require
 * via createRequire()/Module._load died with MODULE_NOT_FOUND in the browser.
 *
 * This test pins the dist bundle to the delegating behavior: with a fake
 * __bvm_process_final__ installed, dist's getBuiltinModule must delegate to it
 * instead of returning undefined.
 */
import { getBuiltinModule } from "../dist/process.js";

describe("dist/process.js getBuiltinModule (M3 path-builtin regression)", () => {
  const realFinal = globalThis.__bvm_process_final__;

  beforeEach(() => {
    globalThis.__bvm_process_final__ = {
      getBuiltinModule: (id) => ({ __mockBuiltin: id }),
    };
  });

  afterEach(() => {
    if (realFinal === undefined) delete globalThis.__bvm_process_final__;
    else globalThis.__bvm_process_final__ = realFinal;
  });

  test("delegates string ids to __bvm_process_final__ instead of returning undefined", () => {
    expect(getBuiltinModule("path")).toEqual({ __mockBuiltin: "path" });
    expect(getBuiltinModule("fs")).toEqual({ __mockBuiltin: "fs" });
    expect(getBuiltinModule("node:events")).toEqual({
      __mockBuiltin: "node:events",
    });
  });

  test("still throws ERR_INVALID_ARG_TYPE for non-string ids", () => {
    expect(() => getBuiltinModule(42)).toThrow();
  });
});
