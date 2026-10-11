// Next.js integration for bundleVFSModules — copy-based host setup.
//
// Usage (next.config.js):
//   import { withBundleVFSModules } from 'my-vfs/src/integrations/next.js';
//   export default withBundleVFSModules({
//     // ... your Next.js config
//   }, { assetDir: 'bvm' });
//
// What it does:
// - Wraps the Next.js config; copies runtime.js + dist/ into
//   `<project>/public/bvm` so Next serves them statically with zero manual
//   wiring. The copy runs TWICE-guarded: once eagerly when next.config.js
//   is evaluated (Next loads the config file at startup in both `next dev`
//   and `next build`), and again on the first webpack compilation via the
//   `webpack` hook. The webpack hook is a belt-and-braces fallback in case
//   a future Next version stops invoking the hook for some compilation.
// - In dev (`next dev`), the webpack hook fires on first compilation; the
//   eager copy means assets already exist even before that.
//
// Pages router vs app router: both serve `public/` statically — the same
// copy works for both. No router-specific code is needed here.
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
  const normalizedBase = assetPublicBase(publicPath);
  let copied = false;

  function ensureAssets() {
    // Idempotent: copyFileSync overwrites; the flag avoids re-walking dist/
    // (18MB) on every webpack rebuild in dev.
    if (copied) return;
    const destDir = path.join(process.cwd(), "public", assetDir);
    copyRuntimeAssets(destDir, { includePlayground });
    copied = true;
  }

  // Eager trigger: Next evaluates next.config.js at startup for both
  // `next dev` and `next build`, so the assets land in public/ before any
  // compilation begins. The webpack hook below is the backstop if a future
  // Next version ever skips the hook for a compilation.
  ensureAssets();

  const userWebpack =
    typeof nextConfig.webpack === "function" ? nextConfig.webpack : null;

  const wrapped = {
    ...nextConfig,
    webpack(config, context) {
      ensureAssets();
      if (userWebpack) return userWebpack(config, context);
      return config;
    },
  };

  // Asset introspection for host apps: the URL prefix the browser uses
  // (e.g. `${__bvmAssetBase}/runtime.js`) and the on-disk dir name under
  // public/. `__`-prefixed keys are ignored by Next's config handling.
  wrapped.__bvmAssetBase = normalizedBase;
  wrapped.__bvmAssetDir = assetDir;

  return wrapped;
}

// Re-export for host apps that want the pieces without the wrapper.
export { copyRuntimeAssets, assetPublicBase };
