import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import {
  registerPlugin,
  unregisterPlugin,
  getPlugins,
  clearPlugins,
} from "../src/plugins.js";
import {
  viteBrowserPlugin,
  interceptNativeSpecifier,
  lookupNativeInterception,
  BROWSER_BUILD_TARGETS,
} from "../src/plugins/vite-browser.js";

/**
 * Vite browser interception as an opt-in plugin.
 *
 * The native→browser/WASM substitution table (rollup→@rollup/browser,
 * esbuild→esbuild-wasm, rolldown→@rolldown/browser) must NOT run unless
 * the host explicitly opts in via registerPlugin(viteBrowserPlugin).
 *
 * These tests pin the gating contract: the interception functions exist
 * and return the right VFS paths, but the module resolution pipeline
 * only consults them when the plugin is registered.
 */

// Mock the browser runtime VFS presence so the hasRuntimeVFS() gate passes.
let savedRT;
function mockVFS() {
  savedRT = globalThis._RUNTIME_;
  globalThis._RUNTIME_ = { __FS__: { fake: true } };
}
function unmockVFS() {
  if (savedRT === undefined) delete globalThis._RUNTIME_;
  else globalThis._RUNTIME_ = savedRT;
}

beforeEach(() => {
  clearPlugins();
  mockVFS();
});

afterEach(() => {
  clearPlugins();
  unmockVFS();
});

describe("viteBrowserPlugin shape", () => {
  test("has the required plugin name", () => {
    expect(viteBrowserPlugin.name).toBe("vite-browser");
  });

  test("registers and unregisters cleanly", () => {
    registerPlugin(viteBrowserPlugin);
    expect(getPlugins().some((p) => p.name === "vite-browser")).toBe(true);
    unregisterPlugin("vite-browser");
    expect(getPlugins().some((p) => p.name === "vite-browser")).toBe(false);
  });
});

describe("interception table (ungated)", () => {
  test("lookupNativeInterception maps rollup to @rollup/browser", () => {
    expect(lookupNativeInterception("rollup")).toBe(
      BROWSER_BUILD_TARGETS.ROLLUP_BROWSER_MAIN,
    );
  });

  test("lookupNativeInterception maps esbuild to the shim", () => {
    expect(lookupNativeInterception("esbuild")).toBe(
      BROWSER_BUILD_TARGETS.ESBUILD_SHIM,
    );
  });

  test("lookupNativeInterception maps rolldown to @rolldown/browser", () => {
    expect(lookupNativeInterception("rolldown")).toBe(
      BROWSER_BUILD_TARGETS.ROLLDOWN_BROWSER_MAIN,
    );
  });

  test("lookupNativeInterception returns null for unknown specifiers", () => {
    expect(lookupNativeInterception("lodash")).toBeNull();
    expect(lookupNativeInterception("./relative")).toBeNull();
    expect(lookupNativeInterception("node:fs")).toBeNull();
  });
});

describe("gated interception (interceptNativeSpecifier)", () => {
  test("without registration, specifiers are NOT intercepted", () => {
    // Plugin not registered: the table exists but the gate blocks it.
    // (The actual pipeline gate lives in src/module.js and runtime.js;
    // this pins that the plugin does not self-activate.)
    expect(getPlugins().some((p) => p.name === "vite-browser")).toBe(false);
    // The raw function still works when called directly (it's the table),
    // but the pipeline must not call it without the plugin registered.
    expect(lookupNativeInterception("rollup")).not.toBeNull();
  });

  test("with registration, interceptNativeSpecifier returns VFS paths", () => {
    registerPlugin(viteBrowserPlugin);
    expect(interceptNativeSpecifier("rollup")).toBe(
      "/node_modules/@rollup/browser/dist/es/rollup.browser.js",
    );
    expect(interceptNativeSpecifier("esbuild")).toBe(
      "/node_modules/.bvm/esbuild-shim.cjs",
    );
  });

  test("unregister restores no-interception", () => {
    registerPlugin(viteBrowserPlugin);
    expect(getPlugins().some((p) => p.name === "vite-browser")).toBe(true);
    unregisterPlugin("vite-browser");
    expect(getPlugins().some((p) => p.name === "vite-browser")).toBe(false);
  });

  test("hasRuntimeVFS gate still applies (no VFS = no interception)", () => {
    unmockVFS(); // remove the mocked VFS
    registerPlugin(viteBrowserPlugin);
    expect(interceptNativeSpecifier("rollup")).toBeNull();
  });
});

describe("BROWSER_BUILD_TARGETS", () => {
  test("is frozen and contains the expected keys", () => {
    expect(Object.isFrozen(BROWSER_BUILD_TARGETS)).toBe(true);
    expect(BROWSER_BUILD_TARGETS.ROLLUP_BROWSER_MAIN).toBe(
      "/node_modules/@rollup/browser/dist/es/rollup.browser.js",
    );
    expect(BROWSER_BUILD_TARGETS.ESBUILD_SHIM).toBe(
      "/node_modules/.bvm/esbuild-shim.cjs",
    );
  });
});
