#!/usr/bin/env node
/**
 * Builds the VFS seed JSON for Vite browser proof.
 *
 * Seeds the dist/ tree of vite from the worktree's node_modules:
 *   - .js/.mjs/.cjs/.json as UTF-8 strings
 *   - package.json (exports-condition resolution)
 *
 * Note: Vite 8.3.1 is the target version. If node_modules has a different
 * version, install it first: npm install vite@8.3.1 --no-save
 *
 * Usage: node scripts/build-vite-seed.mjs [out.json]
 * Default out: tests/vite-seed.json
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const OUT = process.argv[2] || path.join(REPO, "tests", "vite-seed.json");

const seed = {};

function addFile(vfsPath, diskPath) {
  const ext = path.extname(diskPath).toLowerCase();
  if (ext === ".wasm") {
    // Binary WASM: base64 envelope (shape inlineWasmDataUrls expects)
    seed[vfsPath] = {
      encoding: "base64",
      data: fs.readFileSync(diskPath).toString("base64"),
    };
    return;
  }
  seed[vfsPath] = fs.readFileSync(diskPath, "utf8");
}

function addTree(pkgName, subDir) {
  const diskBase = path.join(REPO, "node_modules", pkgName, subDir);
  if (!fs.existsSync(diskBase)) {
    console.error(`Package dir not found: ${diskBase}`);
    console.error(`Install with: npm install ${pkgName}@8.3.1 --no-save`);
    process.exit(1);
  }
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const disk = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip type declarations and docs
        if (ent.name === "types" || ent.name === "docs") continue;
        walk(disk);
        continue;
      }
      const ext = path.extname(ent.name).toLowerCase();
      // Only ship what the browser runtime can consume
      if (
        [".d.mts", ".d.ts", ".d.cts"].some((s) => ent.name.endsWith(s)) ||
        ext === ".map"
      )
        continue;
      if (![".js", ".mjs", ".cjs", ".json", ".wasm"].includes(ext)) continue;
      const rel = path.relative(diskBase, disk);
      const vfsPath = path.posix.join(
        `/node_modules/${pkgName}/${subDir}`,
        rel,
      );
      addFile(vfsPath, disk);
    }
  };
  walk(diskBase);
}

// Vite core dist
addTree("vite", "dist/node");
// Vite package-root misc/ (referenced by the package.json "imports" map,
// e.g. #module-sync-enabled -> ./misc/true.js / ./misc/false.js)
addTree("vite", "misc");
// Vite client entries (CLIENT_ENTRY etc. resolved at import time in
// dist/node/chunks — needed for the case-insensitive-FS check on load)
addTree("vite", "dist/client");

// Vite's bare third-party deps (would otherwise fall through to the esm.sh
// CDN fallback, whose /node/*.mjs builtin rewrites die in the VFS resolve
// hook). Seeded here so they resolve from the VFS directly.
addTree("picomatch", ".");
addTree("tinyglobby", "dist");
addTree("fdir", "dist");

// @rolldown/browser: vite's rolldown/* subpath imports resolve via the
// native interception table (src/browser-builds.js) to these files.
addTree("@rolldown/browser", "dist");

// @napi-rs/wasm-runtime: required by @rolldown/browser's WASI binding.
addTree("@napi-rs/wasm-runtime", ".");

// @emnapi/*: WASI runtime deps of @napi-rs/wasm-runtime.
// The interception table (src/browser-builds.js) maps @emnapi/core and
// @emnapi/runtime to their dist .mjs files; seed the full trees so the
// VFS lookup finds them.
addTree("@emnapi/core", "dist");
addTree("@emnapi/runtime", "dist");
addTree("@emnapi/wasi-threads", "dist");

// @tybys/wasm-util: dep of @napi-rs/wasm-runtime.
addTree("@tybys/wasm-util", "dist");
addTree("@tybys/wasm-util", "lib");

// package.json for each seeded dep (exports-condition resolution)
for (const dep of [
  "tinyglobby",
  "fdir",
  "@emnapi/core",
  "@emnapi/runtime",
  "@emnapi/wasi-threads",
  "@napi-rs/wasm-runtime",
  "@rolldown/browser",
  "@tybys/wasm-util",
]) {
  const depPkgJson = path.join(REPO, "node_modules", dep, "package.json");
  if (fs.existsSync(depPkgJson)) {
    seed[`/node_modules/${dep}/package.json`] = fs.readFileSync(
      depPkgJson,
      "utf8",
    );
  }
}

// package.json for exports resolution
const pkgJsonPath = path.join(REPO, "node_modules", "vite", "package.json");
if (fs.existsSync(pkgJsonPath)) {
  seed["/node_modules/vite/package.json"] = fs.readFileSync(
    pkgJsonPath,
    "utf8",
  );
}

// emnapi detects Node via `process.versions.node`. Our sandbox shims
// `process` (with versions.node) for Node compat, which misleads emnapi
// into taking Node-only paths (worker.once, worker.unref) that don't exist
// on browser Workers. Force the browser lane at seed-build time.
// (Same pattern as scripts/build-rolldown-seed.mjs b79e71e3.)
for (const key of Object.keys(seed)) {
  if (
    typeof seed[key] === "string" &&
    (key.includes("@emnapi/") || key.includes("@napi-rs/")) &&
    seed[key].includes("ENVIRONMENT_IS_NODE")
  ) {
    seed[key] = seed[key].replace(
      /(var|const|let)\s+ENVIRONMENT_IS_NODE\s*=\s*typeof process[^;]+;/g,
      "$1 ENVIRONMENT_IS_NODE = false;",
    );
  }
}

// The WASI worker (@rolldown/browser/dist/wasi-worker-browser.mjs) is
// inlined as a data: URL by inlineWasmDataUrls (runtime.js). A data: URL
// worker cannot resolve bare imports ('@napi-rs/wasm-runtime'), so bundle
// it + transitive deps into one self-contained module here and overwrite
// the seed entry. Uses the worktree's esbuild (devDependency).
// (Same pattern as scripts/build-rolldown-seed.mjs.)
{
  const workerSrc = path.join(
    REPO,
    "node_modules",
    "@rolldown",
    "browser",
    "dist",
    "wasi-worker-browser.mjs",
  );
  const workerKey =
    "/node_modules/@rolldown/browser/dist/wasi-worker-browser.mjs";
  if (fs.existsSync(workerSrc)) {
    let bundled = execSync(
      `node_modules/.bin/esbuild ${JSON.stringify(workerSrc)} --bundle --platform=browser --format=esm`,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    // esbuild --define does not override `var` declarations; patch the
    // ENVIRONMENT_IS_NODE declaration directly (same as the seed patch above).
    bundled = bundled.replace(
      /(var|const|let)\s+ENVIRONMENT_IS_NODE\s*=\s*typeof process[^;]+;/g,
      "$1 ENVIRONMENT_IS_NODE = false;",
    );
    seed[workerKey] = bundled;
    console.log(
      `bundled WASI worker: ${(bundled.length / 1024).toFixed(0)}KB -> ${workerKey}`,
    );
  } else {
    console.warn(`WASI worker not found at ${workerSrc}, skipping bundle`);
  }
}

// WASI fs-proxy payload limit: @napi-rs/wasm-runtime/fs-proxy.js caps a
// single fs response at RESPONSE_PAYLOAD_SIZE (10KB upstream) and throws
// RangeError('payload overflow') above it. vite.build() inside the WASI
// binding returns larger responses (readdir listings, file reads), so raise
// the limit to 16MB. Both protocol sides use the constant: the main-thread
// createOnMessage (seeded from the VFS) and the worker-side createFsProxy
// (esbuild-bundled into the WASI worker above).
// (Same seed-patch pattern as ENVIRONMENT_IS_NODE.)
{
  const FS_PROXY_PAYLOAD_SIZE = 16 * 1024 * 1024;
  for (const key of Object.keys(seed)) {
    if (
      typeof seed[key] === "string" &&
      (key.includes("@napi-rs/wasm-runtime/") ||
        key.endsWith("/wasi-worker-browser.mjs"))
    ) {
      seed[key] = seed[key].replace(
        /(var|const|let)\s+RESPONSE_PAYLOAD_SIZE\s*=\s*10240;?/g,
        `$1 RESPONSE_PAYLOAD_SIZE = ${FS_PROXY_PAYLOAD_SIZE};`,
      );
    }
  }
}

// Builtin shims: when the proof runs with fallbackCDN:false, the
// _dynamic_import handler must resolve Node builtins from the VFS seed
// instead of the jsdelivr CDN. Seed the dist/ shim for every builtin key
// in the manifest (key: bundle key like fs_promises).
// The manifest is hardcoded in runtime.js (const _builtinManifest = {...}).
{
  const runtimeSrc = fs.readFileSync(path.join(REPO, "runtime.js"), "utf8");
  const m = runtimeSrc.match(/const _builtinManifest = (\{[^}]+\})/s);
  if (!m) throw new Error("Could not extract _builtinManifest from runtime.js");
  const manifest = eval(`(${m[1]})`);
  let builtinCount = 0;
  for (const [specifier, file] of Object.entries(manifest)) {
    const key = specifier.replace("/", "_").replace("RUNTIME:", "RUNTIME_");
    const diskPath = path.join(REPO, "dist", file);
    if (fs.existsSync(diskPath)) {
      seed[`/builtins/${key}.js`] = fs.readFileSync(diskPath, "utf8");
      builtinCount++;
    }
  }
  console.log(`Seeded ${builtinCount} builtin shims`);
}

fs.writeFileSync(OUT, JSON.stringify(seed));
const sizeMB = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
console.log(`Wrote ${Object.keys(seed).length} files to ${OUT} (${sizeMB} MB)`);

// Verify version
try {
  const pkg = JSON.parse(seed["/node_modules/vite/package.json"]);
  console.log(`Vite version seeded: ${pkg.version}`);
  if (pkg.version !== "8.3.1") {
    console.warn(`Warning: expected 8.3.1, got ${pkg.version}`);
  }
} catch {
  console.warn("Could not verify vite version");
}
