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
// package.json files for exports-condition resolution.
for (const pkg of [
  "@rolldown/browser",
  "@napi-rs/wasm-runtime",
  "@emnapi/runtime",
]) {
  addFile(
    `/node_modules/${pkg}/package.json`,
    path.join(REPO, "node_modules", pkg, "package.json"),
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
