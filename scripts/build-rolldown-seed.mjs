#!/usr/bin/env node
/**
 * Builds the VFS seed JSON for the @rolldown/browser WASM proof.
 *
 * Seeds the full dist/ trees of @rolldown/browser, @napi-rs/wasm-runtime,
 * and @emnapi/runtime from the worktree's node_modules:
 *   - .js/.mjs/.cjs/.json as UTF-8 strings
 *   - .wasm as {encoding:"base64",data} envelopes (the shape
 *     inlineWasmDataUrls expects)
 *   - package.json for each package (exports-condition resolution)
 *
 * Usage: node scripts/build-rolldown-seed.mjs [out.json]
 * Default out: tests/rolldown-seed.json
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const OUT = process.argv[2] || path.join(REPO, "tests", "rolldown-seed.json");

const seed = {};

function addFile(vfsPath, diskPath) {
  const ext = path.extname(diskPath).toLowerCase();
  if (ext === ".wasm") {
    seed[vfsPath] = {
      encoding: "base64",
      data: fs.readFileSync(diskPath).toString("base64"),
    };
  } else {
    seed[vfsPath] = fs.readFileSync(diskPath, "utf8");
  }
}

function addTree(pkgName, subDir) {
  const diskBase = path.join(REPO, "node_modules", pkgName, subDir);
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const disk = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(disk);
        continue;
      }
      const ext = path.extname(ent.name).toLowerCase();
      // Only ship what the browser runtime can consume; skip type
      // declarations and CJS twins of ESM files we already map.
      if ([".d.mts", ".d.ts", ".d.cts"].some((s) => ent.name.endsWith(s)))
        continue;
      if (![".js", ".mjs", ".cjs", ".json", ".wasm"].includes(ext)) continue;
      const rel = path.relative(path.join(REPO, "node_modules", pkgName), disk);
      const vfsPath =
        "/node_modules/" + pkgName + "/" + rel.split(path.sep).join("/");
      addFile(vfsPath, disk);
    }
  };
  walk(diskBase);
}

// Full dist trees (hashed chunk names make hand-picking fragile).
addTree("@rolldown/browser", "dist");
addTree("@napi-rs/wasm-runtime", ".");
addTree("@emnapi/runtime", "dist");
addTree("@emnapi/core", "dist");
addTree("@emnapi/wasi-threads", "dist");
addTree("@tybys/wasm-util", ".");
addTree("tslib", ".");
// package.json files for exports-condition resolution.
for (const pkg of [
  "@rolldown/browser",
  "@napi-rs/wasm-runtime",
  "@emnapi/runtime",
  "@emnapi/core",
  "@emnapi/wasi-threads",
  "@tybys/wasm-util",
  "tslib",
]) {
  addFile(
    `/node_modules/${pkg}/package.json`,
    path.join(REPO, "node_modules", pkg, "package.json"),
  );
}

// emnapi detects Node via `process.versions.node`. Our sandbox shims
// `process` (with versions.node) for Node compat, which misleads emnapi
// into taking Node-only paths (worker.once, worker.unref) that don't exist
// on browser Workers. Force the browser lane at seed-build time.
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
{
  const workerSrc = path.join(
    REPO,
    "node_modules",
    "@rolldown/browser",
    "dist",
    "wasi-worker-browser.mjs",
  );
  const workerKey =
    "/node_modules/@rolldown/browser/dist/wasi-worker-browser.mjs";
  const bundled = execSync(
    `node_modules/.bin/esbuild ${JSON.stringify(workerSrc)} --bundle --platform=browser --format=esm`,
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  ).replace(
    /(var|const|let)\s+ENVIRONMENT_IS_NODE\s*=\s*typeof process[^;]+;/g,
    "$1 ENVIRONMENT_IS_NODE = false;",
  );
  seed[workerKey] = bundled;
  console.log(
    `bundled WASI worker: ${(bundled.length / 1024).toFixed(0)}KB -> ${workerKey}`,
  );
}

const json = JSON.stringify(seed);
fs.writeFileSync(OUT, json);
const files = Object.keys(seed).length;
const wasmBytes = Object.values(seed)
  .filter((v) => v && v.encoding === "base64")
  .reduce((n, v) => n + Buffer.from(v.data, "base64").length, 0);
console.log(
  `seed: ${files} files, ${(json.length / 1048576).toFixed(1)}MB JSON, ${(wasmBytes / 1048576).toFixed(1)}MB WASM -> ${OUT}`,
);
