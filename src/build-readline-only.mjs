#!/usr/bin/env node
// One-off: rebuild ONLY dist/readline.js from src/readline.js with the same
// esbuild options as src/build-vfs.mjs, without touching other dist bundles.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "terser";
import { nodeGitHubPlugin, esmShPlugin } from "./build-vfs.mjs";
import { nodeModulesPolyfillPlugin } from "esbuild-plugins-node-modules-polyfill";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(__dirname, "readline.js");

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
  plugins: [
    nodeGitHubPlugin(),
    nodeModulesPolyfillPlugin({ globals: { Buffer: true } }),
    esmShPlugin(),
  ],
  legalComments: "linked",
  outdir: "dist",
});

const jsFile = result.outputFiles.find((f) => f.path.endsWith(".js"));
if (!jsFile) throw new Error("No JS output found");
const min = await minify(jsFile.text, {
  compress: true,
  mangle: true,
  module: true,
});
const outPath = path.resolve(__dirname, "..", "dist", "readline.js");
fs.writeFileSync(outPath, min.code);
console.log(`rebuilt ${outPath} (${min.code.length} bytes)`);
