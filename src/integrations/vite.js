// Vite plugin for bundleVFSModules — copy-based host integration.
//
// Usage (vite.config.js):
//   import { bundleVFSModules } from 'my-vfs/src/integrations/vite.js';
//   export default {
//     plugins: [bundleVFSModules({ assetDir: 'bvm' })],
//   };
//
// What it does:
// - On configResolved (and buildStart as a safety net): copies runtime.js
//   + dist/ into the Vite public dir (default `<publicDir>/bvm`), so
//   `vite build` emits them and `vite dev` serves them with zero manual
//   wiring. The plugin-owned dir is wiped before each copy so files
//   removed from the repo cannot linger as stale copies.
// - In dev (configureServer): watches the repo's runtime.js/dist/ and
//   re-copies on change, so edits to the library are live without a
//   Vite restart. `vite preview` serves the copied assets from dist/
//   (publicDir contents are copied into dist/ at build time).
//
// What it does NOT do:
// - Browser-interception (the Vite 7 browser work) is headed toward an
//   opt-in plugin, not core and not this integration. This plugin only
//   serves assets. Pass `interception: true` to get an explicit error
//   pointing at the future plugin — fail loud, not silent.
import fs from "node:fs";
import path from "node:path";
import {
  copyRuntimeAssets,
  assetPublicBase,
  RUNTIME_JS,
  DIST_DIR,
  UI_HTML,
} from "./assets.js";

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
  let copied = false;

  const copyAssets = () => {
    if (!resolvedPublicDir) return;
    const destDir = path.join(resolvedPublicDir, assetDir);
    // Wipe the plugin-owned dir first: copyFileSync overwrites changed
    // files, but it can never remove a file that was deleted from the
    // repo — without the wipe, stale copies linger in publicDir.
    fs.rmSync(destDir, { recursive: true, force: true });
    copyRuntimeAssets(destDir, { includePlayground });
    copied = true;
  };

  const plugin = {
    name: "vite-plugin-bundle-vfs-modules",

    // Public URL prefix for the copied assets. Host apps that need to
    // rewrite the CDN base in runtime.js can read plugin.assetBase.
    assetBase: base,

    configResolved(config) {
      resolvedPublicDir = config.publicDir;
      copyAssets();
    },

    buildStart() {
      // Safety net: if configResolved did not run (unusual, but seen in
      // some programmatic Vite uses), still copy the assets before the
      // build starts. Skipped when configResolved already copied.
      if (!copied) copyAssets();
    },

    configureServer(server) {
      // Dev mode: re-copy when the library's source assets change, so
      // edits to runtime.js/dist are live without a Vite restart.
      if (!resolvedPublicDir) return;
      const watchTargets = [RUNTIME_JS, DIST_DIR];
      if (includePlayground) watchTargets.push(UI_HTML);
      try {
        server.watcher.add(watchTargets);
        server.watcher.on("change", (changedPath) => {
          if (
            watchTargets.some(
              (t) => changedPath === t || changedPath.startsWith(t + path.sep),
            )
          ) {
            copyAssets();
          }
        });
      } catch {
        // Watching is best-effort; a broken watcher must not break dev.
      }
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
