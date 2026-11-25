#!/usr/bin/env node
// One-off: rebuild ONLY dist/fs.js and dist/fs_promises.js from src/fs.js and
// src/fs/promises.js with the same esbuild options as src/build-vfs.mjs,
// without touching other dist bundles.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "terser";
import { nodeGitHubPlugin, esmShPlugin } from "./build-vfs.mjs";
import { nodeModulesPolyfillPlugin } from "esbuild-plugins-node-modules-polyfill";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build-time TARGET_NODE gate (src/version-gate.js): fs is a gated
// module since the rmdir-recursive gate, so this one-off rebuild must
// bake the target exactly like src/build-vfs.mjs bundleToString does.
// TARGET_NODE=24 builds the v24 dist; default is 26. An unrecognised
// value fails the build — never silently defaults.
const BUILD_TARGET_NODE = process.env.TARGET_NODE ?? "26";
if (BUILD_TARGET_NODE !== "24" && BUILD_TARGET_NODE !== "26") {
  throw new Error(
    `TARGET_NODE must be '24' or '26', got ${JSON.stringify(BUILD_TARGET_NODE)}`,
  );
}

async function buildOne(entryRel, outRel) {
  const entry = path.resolve(__dirname, entryRel);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: true,
    write: false,
    external: [],
    treeShaking: true,
    define: { __TARGET_NODE__: JSON.stringify(BUILD_TARGET_NODE) },
    plugins: [
      nodeGitHubPlugin(),
      nodeModulesPolyfillPlugin({ globals: { Buffer: true } }),
      esmShPlugin(),
    ],
    legalComments: "linked",
    outdir: "dist",
  });
  const jsFile = result.outputFiles.find((f) => f.path.endsWith(".js"));
  if (!jsFile) throw new Error(`No JS output for ${entryRel}`);
  const min = await minify(jsFile.text, {
    compress: true,
    mangle: true,
    module: true,
  });
  const outPath = path.resolve(__dirname, "..", "dist", outRel);
  fs.writeFileSync(outPath, min.code);
  console.log(`rebuilt ${outPath} (${min.code.length} bytes)`);
}

await buildOne("fs.js", "fs.js");
await buildOne("fs/promises.js", "fs_promises.js");
