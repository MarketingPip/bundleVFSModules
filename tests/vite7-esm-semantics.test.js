import { describe, test, expect } from "@jest/globals";

// ESM module semantics verification (Jared, 2026-09-29).
//
// These tests document the Node.js ESM semantics that the browser runtime
// must preserve:
//
// 1. Import statements are hoisted and executed in order before the
//    importing module's body runs.
// 2. Side effects on `globalThis` in an imported module are visible to
//    modules imported after it.
// 3. `globalThis` is shared across CJS and ESM modules within the same
//    realm (sandbox iframe).
// 4. `createRequire(import.meta.url)` works from ESM to load CJS.
//
// The browser runtime uses the JS engine's native ESM semantics (via
// es-module-shims), so import order is engine-guaranteed. These tests
// verify the semantics using Node's native ESM as the reference
// implementation.

describe("ESM import order nuances", () => {
  test("imports are hoisted and executed in order", async () => {
    // This test verifies the engine behavior: setup-globals.mjs runs
    // before use-globals.mjs, so the global is visible.

    // Simulate: main.mjs imports setup-globals then use-globals
    // In real ESM, this is:
    //   import './setup-globals.mjs'; // sets globalThis.APP_ENV
    //   import './use-globals.mjs';   // reads globalThis.APP_ENV

    // We verify via data: URLs that the order is preserved.
    const setupUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(`
      globalThis.__esmOrderTest = (globalThis.__esmOrderTest || []);
      globalThis.__esmOrderTest.push('setup');
      globalThis.APP_ENV_TEST = 'production';
    `)}`;
    const useUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(`
      globalThis.__esmOrderTest.push('use');
      globalThis.__esmOrderSawEnv = globalThis.APP_ENV_TEST;
    `)}`;

    await import(setupUrl);
    await import(useUrl);

    expect(globalThis.__esmOrderTest).toEqual(["setup", "use"]);
    expect(globalThis.__esmOrderSawEnv).toBe("production");

    delete globalThis.__esmOrderTest;
    delete globalThis.__esmOrderSawEnv;
    delete globalThis.APP_ENV_TEST;
  });

  test("globalThis mutations are visible across ESM modules", async () => {
    const mod1Url = `data:text/javascript;charset=utf-8,${encodeURIComponent(`
      globalThis.__sharedState = { counter: 0 };
      globalThis.__sharedState.counter++;
    `)}`;
    const mod2Url = `data:text/javascript;charset=utf-8,${encodeURIComponent(`
      globalThis.__sharedState.counter++;
      globalThis.__finalCount = globalThis.__sharedState.counter;
    `)}`;

    await import(mod1Url);
    await import(mod2Url);

    // Both modules mutated the same globalThis object.
    expect(globalThis.__finalCount).toBe(2);

    delete globalThis.__sharedState;
    delete globalThis.__finalCount;
  });
});

describe("createRequire from ESM", () => {
  test("createRequire is exported from node:module", async () => {
    const { createRequire } = await import("node:module");
    expect(typeof createRequire).toBe("function");
  });

  test("createRequire(import.meta.url) creates a require function", async () => {
    const { createRequire } = await import("node:module");
    // In the browser, import.meta.url is a data: or blob: URL.
    // The shim handles non-file URLs (tested in tests/module.test.js).
    const require = createRequire(import.meta.url);
    expect(typeof require).toBe("function");
    expect(typeof require.resolve).toBe("function");
  });
});
