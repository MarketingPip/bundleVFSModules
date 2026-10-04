// Shared asset helper for framework integrations.
//
// Copies the runtime's servable assets (runtime.js + dist/ bundles) into a
// host app's static directory so the browser can load them. This is the
// copy-based setup: the host app serves the files, the library does not
// bake in any framework-specific serving logic.
//
// Asset layout after copy:
//   <destDir>/runtime.js      — the host runtime (CodeSandbox)
//   <destDir>/dist/*.js      — the shim bundles (loaded on demand)
//   <destDir>/ui.html        — optional playground page (opt-in)
//
// The Vite browser-interception work is headed toward becoming an opt-in
// plugin, not core. These integrations only serve assets; they do not wire
// interception. A future `interception` plugin will build on this seam.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/integrations/ -> repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const RUNTIME_JS = path.join(REPO_ROOT, "runtime.js");
export const DIST_DIR = path.join(REPO_ROOT, "dist");
export const UI_HTML = path.join(REPO_ROOT, "ui.html");

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Copy runtime assets to a host app's static directory.
 *
 * @param {string} destDir - absolute path to the target directory
 * @param {object} [options]
 * @param {boolean} [options.includePlayground=false] - also copy ui.html
 * @returns {{ runtimeJs: string, distDir: string, uiHtml?: string }} copied paths
 */
export function copyRuntimeAssets(destDir, options = {}) {
  const { includePlayground = false } = options;
  if (!path.isAbsolute(destDir)) {
    throw new Error(
      `copyRuntimeAssets: destDir must be absolute, got '${destDir}'`,
    );
  }
  if (!fs.existsSync(RUNTIME_JS)) {
    throw new Error(`copyRuntimeAssets: runtime.js not found at ${RUNTIME_JS}`);
  }
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error(`copyRuntimeAssets: dist/ not found at ${DIST_DIR}`);
  }

  fs.mkdirSync(destDir, { recursive: true });
  const runtimeJs = path.join(destDir, "runtime.js");
  fs.copyFileSync(RUNTIME_JS, runtimeJs);

  const distDir = path.join(destDir, "dist");
  copyDirSync(DIST_DIR, distDir);

  const result = { runtimeJs, distDir };
  if (includePlayground) {
    if (!fs.existsSync(UI_HTML)) {
      throw new Error(`copyRuntimeAssets: ui.html not found at ${UI_HTML}`);
    }
    const uiHtml = path.join(destDir, "ui.html");
    fs.copyFileSync(UI_HTML, uiHtml);
    result.uiHtml = uiHtml;
  }
  return result;
}

/**
 * Compute the public URL base for the copied assets.
 * Host apps serve destDir at some public path; this is the URL prefix
 * the browser uses to load runtime.js and dist/ files.
 *
 * @param {string} publicPath - e.g. "/bvm" (must start with /)
 * @returns {string} normalized prefix without trailing slash
 */
export function assetPublicBase(publicPath = "/bvm") {
  if (!publicPath.startsWith("/")) {
    throw new Error(
      `assetPublicBase: publicPath must start with '/', got '${publicPath}'`,
    );
  }
  return publicPath.endsWith("/") && publicPath.length > 1
    ? publicPath.slice(0, -1)
    : publicPath;
}
