// Next.js integration for bundleVFSModules — copy-based host setup.
//
// Usage (next.config.js):
//   import { withBundleVFSModules } from 'my-vfs/src/integrations/next.js';
//   export default withBundleVFSModules({
//     // ... your Next.js config
//   }, { assetDir: 'bvm' });
//
// What it does:
// - Wraps the Next.js config; on webpack build start, copies runtime.js +
//   dist/ into `<project>/public/bvm` so Next serves them statically with
//   zero manual wiring.
// - In dev (`next dev`), the same copy runs on first webpack compilation.
//
// What it does NOT do:
// - Browser-interception is a future opt-in plugin, not core and not this
//   integration. See vite.js for the reserved `interception` option.
import path from "node:path";
import { copyRuntimeAssets, assetPublicBase } from "./assets.js";

/**
 * @param {object} [nextConfig={}] - the host's Next.js config
 * @param {object} [options]
 * @param {string} [options.assetDir='bvm'] - subdirectory under public/
 * @param {string} [options.publicPath='/bvm'] - URL prefix for the assets
 * @param {boolean} [options.includePlayground=false] - also copy ui.html
 * @returns {object} wrapped Next.js config
 */
export function withBundleVFSModules(nextConfig = {}, options = {}) {
  const {
    assetDir = "bvm",
    publicPath = "/bvm",
    includePlayground = false,
  } = options;

  // Validate publicPath early so host apps fail fast on typos.
  assetPublicBase(publicPath);
  let copied = false;

  function ensureAssets() {
    // Idempotent: copyFileSync overwrites; the flag avoids re-walking dist/
    // (18MB) on every webpack rebuild in dev.
    if (copied) return;
    const destDir = path.join(process.cwd(), "public", assetDir);
    copyRuntimeAssets(destDir, { includePlayground });
    copied = true;
  }

  const userWebpack =
    typeof nextConfig.webpack === "function" ? nextConfig.webpack : null;

  return {
    ...nextConfig,
    webpack(config, context) {
      ensureAssets();
      if (userWebpack) return userWebpack(config, context);
      return config;
    },
  };
}

// Re-export for host apps that want the pieces without the wrapper.
export { copyRuntimeAssets, assetPublicBase };
