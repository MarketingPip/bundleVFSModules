// The sandbox template must expose a stable `globalThis._RUNTIME_` alias
// pointing at the UUID-specific runtime object.
//
// Background: the sandbox creates `globalThis._RUNTIME_${uuid}_` (UUID-
// suffixed for per-sandbox isolation). But three consumers need a stable,
// non-UUID path:
//   1. src/browser-builds.js `hasRuntimeVFS()` checks `globalThis._RUNTIME_.__FS__`
//   2. src/vendor/esbuild-shim.cjs `readWasmBytes()` checks `globalThis._RUNTIME_.__FS__`
//   3. src/fs.js `getRuntime()` returns `globalThis._RUNTIME_`
//
// The `_RUNTIME_` → `_RUNTIME_${uuid}_` AST rewrite (replaceGlobalThisVar)
// only applies to Node builtins, NOT to VFS-loaded CJS like the esbuild
// shim. Without the alias, vite.build() with minify:"esbuild" fails with:
//   "esbuild-shim: browser runtime VFS (globalThis._RUNTIME_.__FS__) is not available"
// (M3 probe 2026-09-29: vite.build() progressed past the hang but hit this.)
//
// The alias is per-realm (each sandbox gets its own iframe/globalThis),
// so it does not break isolation.
// jest globals (describe/expect/test) — converted from vitest 2026-10-01
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("sandbox template exposes stable `globalThis._RUNTIME_` alias", () => {
  // The template now lives in src/sandbox-template.js (built from
  // src/sandbox/*.js); SandboxRuntime.generate() substitutes %%UUID%%.
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "sandbox-template.js"),
    "utf8",
  );

  test("template assigns _RUNTIME_ alias after the UUID-specific object", () => {
    // The template creates: globalThis._RUNTIME%%UUID%%_ = {...}
    // It must also create: globalThis._RUNTIME_ = globalThis._RUNTIME%%UUID%%_;
    // (%%UUID%% is substituted at sandbox generation time)
    expect(src).toMatch(
      /globalThis\._RUNTIME_ = globalThis\._RUNTIME%%UUID%%_;/,
    );
  });

  test("alias is assigned in the SandboxRuntime.generate() template", () => {
    // The alias must be part of the generated sandbox boot code. The template
    // is consumed by SandboxRuntime.generate() in runtime.js — verify the
    // import wiring plus the alias in the template.
    const runtimeSrc = fs.readFileSync(
      path.join(__dirname, "..", "runtime.js"),
      "utf8",
    );
    expect(runtimeSrc).toMatch(
      /import \{ SANDBOX_TEMPLATE \} from "\.\/src\/sandbox-template\.js"/,
    );
    expect(src).toMatch(
      /globalThis\._RUNTIME_ = globalThis\._RUNTIME%%UUID%%_;/,
    );
  });
});
