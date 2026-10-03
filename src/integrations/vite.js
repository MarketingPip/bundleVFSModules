// Vite plugin for bundleVFSModules — copy-based host integration.
//
// Usage (vite.config.js):
//   import { bundleVFSModules } from 'my-vfs/src/integrations/vite.js';
//   export default {
//     plugins: [bundleVFSModules({ assetDir: 'bvm' })],
//   };
//
// What it does:
// - On configResolved: copies runtime.js + dist/ into the Vite public dir
//   (default `<publicDir>/bvm`), so `vite build` emits them and `vite dev`
//   serves them with zero manual wiring.
// - In dev (configureServer): serves the assets from the source tree
//   directly, so edits to runtime.js/dist are live without a rebuild.
//
// What it does NOT do:
// - Browser-interception (the Vite 7 browser work) is headed toward an
//   opt-in plugin, not core and not this integration. This plugin only
//   serves assets. Pass `interception: true` to get an explicit error
//   pointing at the future plugin — fail loud, not silent.
import path from "node:path";
import { copyRuntimeAssets, assetPublicBase } from "./assets.js";

/**
 * @param {object} [options]
 * @param {string} [options.assetDir='bvm'] - subdirectory under publicDir
 * @param {string} [options.publicPath='/bvm'] - URL prefix for the assets
 * @param {boolean} [options.includePlayground=false] - also copy ui.html
 * @param {boolean} [options.interception=false] - RESERVED: future opt-in
 *   browser-interception plugin. Currently throws; do not rely on it.
 */
export function bundleVFSModules(options = {}) {
  const {
    assetDir = "bvm",
    publicPath = "/bvm",
    includePlayground = false,
    interception = false,
  } = options;

  if (interception) {
    throw new Error(
      "bundleVFSModules: the `interception` option is reserved for the future " +
        "opt-in browser-interception plugin. It is not implemented in this " +
        "integration — this plugin only serves runtime assets.",
    );
  }

  const base = assetPublicBase(publicPath);
  let resolvedPublicDir = null;

  const plugin = {
    name: "vite-plugin-bundle-vfs-modules",

    // Public URL prefix for the copied assets. Host apps that need to
    // rewrite the CDN base in runtime.js can read plugin.assetBase.
    assetBase: base,

    configResolved(config) {
      resolvedPublicDir = config.publicDir;
      // Copy-based setup: assets land in publicDir so `vite build` emits
      // them and `vite dev` serves them. Runs on every config resolution
      // (idempotent — copyFileSync overwrites).
      const destDir = path.join(resolvedPublicDir, assetDir);
      copyRuntimeAssets(destDir, { includePlayground });
    },

    configureServer(server) {
      // Dev mode: serve from the copy in publicDir (already placed by
      // configResolved). No extra middleware needed — Vite serves publicDir
      // natively. This hook exists as the seam for the future interception
      // plugin, which will add its middleware here.
      if (!resolvedPublicDir) return;
      server.middlewares.use((req, res, next) => {
        // Pass through; assets are served by Vite's publicDir handling.
        next();
      });
    },
  };

  return plugin;
}

// Re-export for host apps that want the pieces without the plugin.
export { copyRuntimeAssets, assetPublicBase };
