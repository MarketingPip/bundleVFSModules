// Vendor browser/WASM builds for native-only packages (real Vite 7:
// rollup → @rollup/browser, esbuild → esbuild-wasm shim). Used by the
// parent '_dynamic_import' handler so ESM 'import 'rollup'' resolves
// exactly like CJS require('rollup') (src/module.js). Ungated lookup: the
// handler only runs when serving the browser runtime's VFS.
import { lookupNativeInterception } from "../plugins/vite-browser.js";

/**
 * Sync gate for Vite browser interception (Jared 2026-10-04): the
 * native→browser/WASM substitution table only applies when the host has
 * opted in via registerPlugin(viteBrowserPlugin).
 */
export function isViteBrowserInterceptionActive() {
  const plugins = getPlugins();
  for (const p of plugins) {
    if (p && p.name === "vite-browser") return true;
  }
  return false;
}
// Plugin API (src/plugins.js): transform hooks wired into the parent-side
// _build_file interop handler below. The TypeScript plugin ships registered
// by default so .ts/.tsx modules work out of the box; hosts can
// unregisterPlugin("typescript") or register their own. Plugin transforms
// run at the TOP of _build_file, before detectModuleSystem, so TS->JS
// output flows through the existing CJS/ESM detection unchanged.
import {
  applyTransformPlugins,
  applyResolvePlugins,
  applyLoadPlugins,
  dispatchLoader,
  registerPlugin,
  validatePlugin,
  getPlugins,
} from "../plugins.js";
import { typescriptPlugin } from "../plugins/typescript.js";
import { jsonPlugin } from "../plugins/json.js";

registerPlugin(typescriptPlugin);
// The JSON plugin is built-in (builtIn:true → lowest priority): it proves
// the Part B hooks cover what used to be hardcoded, and any user plugin
// registered later for /\.json$/ wins over it.
registerPlugin(jsonPlugin);

// ─── Re-exports for the rest of the host runtime (cutover) ───────────────────
// The sections of runtime.js below line 690 use the plugin API imported
// above. Re-exported here so the cutover can replace those imports with a
// single import from this module. lookupNativeInterception is re-exported
// for the _dynamic_import handler (runtime.js:2616, 5583).
export {
  applyTransformPlugins,
  applyResolvePlugins,
  applyLoadPlugins,
  dispatchLoader,
  registerPlugin,
  validatePlugin,
  getPlugins,
  typescriptPlugin,
  jsonPlugin,
  lookupNativeInterception,
};
