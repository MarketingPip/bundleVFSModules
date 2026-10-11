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
//   wiring. The copy runs eagerly when next.config.js is evaluated — Next
//   loads the config file at startup for both `next dev` and `next build`
//   (verified on Next 16: assets land in public/ even when the build itself
//   fails later). A `webpack`-hook re-copy is attached as a belt-and-braces
//   fallback on Next < 16; see below.
// - In dev (`next dev`), the eager copy means assets exist before the first
//   compilation; the webpack hook (Next < 16) re-checks on each compile.
//
// Next 16+ note: Turbopack is the default bundler and a `webpack` key in
// the config is a hard build error under Turbopack. Since the eager copy
// is the primary trigger, the wrapper OMITS its own `webpack` hook when it
// detects Next >= 16 (version read from the host's node_modules). On Next
// 13/14/15 (webpack default) the hook is attached as before. If the Next
// version can't be detected, the hook is attached (old behavior).
//
// Pages router vs app router: both serve `public/` statically — the same
// copy works for both. No router-specific code is needed here.
//
// What it does NOT do:
// - Browser-interception is a future opt-in plugin, not core and not this
//   integration. See vite.js for the reserved `interception` option.
import fs from "node:fs";
import path from "node:path";
import { copyRuntimeAssets, assetPublicBase } from "./assets.js";

/**
 * Symbols for asset introspection on the wrapped Next config.
 *
 * Why symbols and not plain `__bvmAssetBase` string keys: Next 16 deep-clones
 * the config with `Reflect.ownKeys` (which picks up non-enumerable keys too)
 * and re-validates the clone against a strict zod schema that warns on every
 * unrecognized STRING key — so any string key we add prints
 * "Unrecognized key(s) in object" on every build. Zod ignores symbol keys,
 * and the clone preserves them, so symbols are warning-free on all versions.
 *
 * Host apps read them like:
 *   import { BVM_ASSET_BASE } from 'my-vfs/src/integrations/next.js';
 *   const base = config[BVM_ASSET_BASE]; // e.g. "/bvm"
 */
export const BVM_ASSET_BASE = Symbol.for("bundleVFSModules.assetBase");
export const BVM_ASSET_DIR = Symbol.for("bundleVFSModules.assetDir");

/**
 * Detect the host app's installed Next.js major version by walking up from
 * the project dir looking for node_modules/next/package.json.
 *
 * @returns {number|null} major version, or null when undetectable
 */
export function detectNextMajor() {
  let dir = process.cwd();
  while (true) {
    const pkgPath = path.join(dir, "node_modules", "next", "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const { version } = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        const major = parseInt(String(version).split(".")[0], 10);
        return Number.isNaN(major) ? null : major;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

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
  // compilation begins — regardless of bundler (webpack or Turbopack).
  ensureAssets();

  const userWebpack =
    typeof nextConfig.webpack === "function" ? nextConfig.webpack : null;

  // Next 16+ defaults to Turbopack, where a `webpack` key is a hard build
  // error. The eager copy above already delivered the assets, so skip our
  // hook there. On Next <= 15 (or when undetectable) keep the hook as the
  // backstop for compilations that run after config evaluation.
  const nextMajor = detectNextMajor();
  const attachWebpackHook = nextMajor === null || nextMajor < 16;

  const wrapped = { ...nextConfig };
  if (attachWebpackHook) {
    wrapped.webpack = function bvmWebpack(config, context) {
      ensureAssets();
      if (userWebpack) return userWebpack(config, context);
      return config;
    };
  }
  // NOTE: if the user supplied their own `webpack` on Next 16+ with the
  // default Turbopack bundler, Next itself errors on their key — that is
  // their config to fix (pass --webpack or configure Turbopack); we don't
  // silently drop it.

  // Asset introspection for host apps: the URL prefix the browser uses
  // (e.g. `${config[BVM_ASSET_BASE]}/runtime.js`) and the on-disk dir name
  // under public/. Symbol keys survive Next 16's config clone and are
  // ignored by its strict zod validation — no "Unrecognized key(s)" warning.
  // Non-enumerable so they never leak into spreads/serialization.
  Object.defineProperties(wrapped, {
    [BVM_ASSET_BASE]: { value: normalizedBase, enumerable: false },
    [BVM_ASSET_DIR]: { value: assetDir, enumerable: false },
  });

  return wrapped;
}

// Re-export for host apps that want the pieces without the wrapper.
export { copyRuntimeAssets, assetPublicBase };
