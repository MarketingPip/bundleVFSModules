#!/usr/bin/env node
/**
 * Builds the VFS seed JSON for @rollup/browser WASM proof.
 *
 * Seeds the ESM dist/ tree of @rollup/browser from the worktree's node_modules:
 *   - .js/.mjs as UTF-8 strings
 *   - .wasm as {encoding:"base64",data} envelopes (the shape
 *     inlineWasmDataUrls expects)
 *   - package.json (exports-condition resolution)
 *
 * Usage: node scripts/build-rollup-seed.mjs [out.json]
 * Default out: tests/rollup-seed.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const OUT = process.argv[2] || path.join(REPO, "tests", "rollup-seed.json");

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

// @rollup/browser ESM build: the interception target for `import "rollup"`.
// The ESM build (dist/es/) provides named exports; the WASM binding is
// loaded via new URL("bindings_wasm_bg.wasm", import.meta.url), which
// inlineWasmDataUrls rewrites to a data: URL at serve time.
addTree("@rollup/browser", "dist/es");

// package.json for exports-condition resolution
const pkgJson = path.join(
  REPO,
  "node_modules",
  "@rollup/browser",
  "package.json",
);
seed["/node_modules/@rollup/browser/package.json"] = fs.readFileSync(
  pkgJson,
  "utf8",
);

const out = JSON.stringify(seed);
fs.writeFileSync(OUT, out);
const fileCount = Object.keys(seed).length;
console.log(
  `seed: ${fileCount} files, ${(out.length / 1024 / 1024).toFixed(1)}MB JSON -> ${OUT}`,
);
