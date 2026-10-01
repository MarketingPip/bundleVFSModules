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
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const OUT = process.argv[2] || path.join(REPO, "tests", "vite-seed.json");

const seed = {};

function addFile(vfsPath, diskPath) {
  // Vite dist is JS-only; no WASM to handle
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
      if (![".js", ".mjs", ".cjs", ".json"].includes(ext)) continue;
      const rel = path.relative(diskBase, disk);
      const vfsPath = `/node_modules/${pkgName}/${subDir}/${rel}`.replace(
        /\\/g,
        "/",
      );
      addFile(vfsPath, disk);
    }
  };
  walk(diskBase);
}

// Vite core dist
addTree("vite", "dist/node");

// package.json for exports resolution
const pkgJsonPath = path.join(REPO, "node_modules", "vite", "package.json");
if (fs.existsSync(pkgJsonPath)) {
  seed["/node_modules/vite/package.json"] = fs.readFileSync(
    pkgJsonPath,
    "utf8",
  );
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
