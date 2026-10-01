// Red-first tests for Rolldown browser-build interception (Vite 8).
// Vite 8 replaces Rollup with Rolldown; the browser runtime must substitute
// the vendor's @rolldown/browser build when user code requires 'rolldown'.
import {
  lookupNativeInterception,
  BROWSER_BUILD_TARGETS,
} from "../src/browser-builds.js";

describe("rolldown browser-build interception (Vite 8)", () => {
  test("rolldown -> @rolldown/browser main", () => {
    expect(lookupNativeInterception("rolldown")).toBe(
      "/node_modules/@rolldown/browser/dist/index.browser.mjs",
    );
  });

  test("rolldown/experimental -> browser build", () => {
    expect(lookupNativeInterception("rolldown/experimental")).toBe(
      "/node_modules/@rolldown/browser/dist/experimental-index.browser.mjs",
    );
  });

  test("rolldown/plugins -> browser build", () => {
    expect(lookupNativeInterception("rolldown/plugins")).toBe(
      "/node_modules/@rolldown/browser/dist/plugins-index.browser.mjs",
    );
  });

  test("rolldown subpath passthrough", () => {
    expect(lookupNativeInterception("rolldown/utils")).toBe(
      "/node_modules/@rolldown/browser/dist/utils-index.mjs",
    );
  });

  test("BROWSER_BUILD_TARGETS includes rolldown entries", () => {
    expect(BROWSER_BUILD_TARGETS.ROLLDOWN_BROWSER_MAIN).toBe(
      "/node_modules/@rolldown/browser/dist/index.browser.mjs",
    );
    expect(BROWSER_BUILD_TARGETS.ROLLDOWN_BROWSER_DIR).toBe(
      "/node_modules/@rolldown/browser",
    );
  });

  test("@napi-rs/wasm-runtime -> VFS path", () => {
    expect(lookupNativeInterception("@napi-rs/wasm-runtime")).toBe(
      "/node_modules/@napi-rs/wasm-runtime/runtime.js",
    );
  });

  test("@napi-rs/wasm-runtime/fs -> VFS path", () => {
    expect(lookupNativeInterception("@napi-rs/wasm-runtime/fs")).toBe(
      "/node_modules/@napi-rs/wasm-runtime/dist/fs.js",
    );
  });

  test("@emnapi/runtime -> VFS path", () => {
    expect(lookupNativeInterception("@emnapi/runtime")).toBe(
      "/node_modules/@emnapi/runtime/dist/emnapi.mjs",
    );
  });
});
