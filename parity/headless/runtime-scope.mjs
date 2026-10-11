#!/usr/bin/env node
// parity/headless/runtime-scope.mjs — the "same core runtime" for the
// headless host abstraction (roadmap §4; Nodepod's src/headless.ts +
// src/host/ pattern, techniques only — no Nodepod code).
//
// The host runtime ships as src/runtime/*.js modules whose shared scope in
// the assembled runtime.js carries module-scope bare references
// (_builtinManifest, normalizeBuiltinSpecifier, stripAnsi, builtinModules).
// The extracted modules keep those as bare identifiers; the established
// module-test pattern injects them via globalThis. This module does the
// injection once, then re-exports the pieces the headless host needs:
//
//   - SandboxRuntime.generate() — the REAL sandbox template generator, the
//     same script the iframe path executes (byte-identical template).
//   - The _build_file transform pipeline: plugin hooks, detectModuleSystem,
//     convertCjsToEsm / convertEsmToCjs, replaceGlobalThisVar (the
//     globalThis._RUNTIME_ -> globalThis._RUNTIME<uuid>_ AST rewrite),
//     transformImportsToLoadModule.
//   - ImportResolver — the entry-point import extraction execute() uses.
//
// Both transports (in-process node:vm and Node worker_threads via
// worker-entry.mjs) build on this scope, so the core runtime is identical
// whichever host carries it.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = require("node:path").resolve(
  require("node:url").fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
);

const [builtins, terminal, builtinModulesMod] = await Promise.all([
  import("../../src/runtime/builtins.js"),
  import("../../src/runtime/terminal.js"),
  import("../../src/runtime/builtin-modules.js"),
]);

// Module-scope bare references, injected exactly like the module tests do.
// globalThis assignment (not const) keeps the ESM bare-identifier lookup
// working in sandbox-runtime.js's generate().
if (typeof globalThis._builtinManifest === "undefined") {
  globalThis._builtinManifest = builtins._builtinManifest;
}
if (typeof globalThis.normalizeBuiltinSpecifier === "undefined") {
  globalThis.normalizeBuiltinSpecifier = builtins.normalizeBuiltinSpecifier;
}
if (typeof globalThis.stripAnsi === "undefined") {
  globalThis.stripAnsi = terminal.stripAnsi;
}
if (typeof globalThis.builtinModules === "undefined") {
  globalThis.builtinModules = builtinModulesMod.builtinModules;
}

const [sandboxRuntimeMod, transformsCjs, transformsEsm, transformsImports, pluginsMod, importResolverMod] =
  await Promise.all([
    import("../../src/runtime/sandbox-runtime.js"),
    import("../../src/runtime/transforms-cjs.js"),
    import("../../src/runtime/transforms-esm.js"),
    import("../../src/runtime/transforms-imports.js"),
    import("../../src/plugins.js"),
    import("../../src/runtime/import-resolver.js"),
  ]);

export { repoRoot };
export const SandboxRuntime = sandboxRuntimeMod.SandboxRuntime;
export const builtinManifest = builtins._builtinManifest;
export const builtinModules = builtinModulesMod.builtinModules;

// _build_file pipeline (mirrors the interop handler in
// CodeSandbox.execute(), minus the source-map registry which is
// diagnostics-only and not needed for parity verdicts).
export const {
  applyResolvePlugins,
  applyLoadPlugins,
  applyTransformPlugins,
  dispatchLoader,
} = pluginsMod;
export const { convertCjsToEsm, detectModuleSystem } = transformsCjs;
export const { convertEsmToCjs } = transformsEsm;
export const { replaceGlobalThisVar, transformImportsToLoadModule } =
  transformsImports;
export const ImportResolver = importResolverMod.ImportResolver;
