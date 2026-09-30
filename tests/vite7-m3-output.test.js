import { describe, test, expect, beforeAll } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "../node_modules/vite/dist/node/index.js";

/**
 * M3 output validation: vite.build() emits 1 chunk, and the chunk is
 * validated by REAL EXECUTION — it runs, exports the expected names, and
 * the minified build is smaller than the unminified build.
 *
 * Fixture mirrors the M3 browser fixture (seed /fixture/src/add.js +
 * /fixture/src/main.js): add.js exports add(a,b); main.js exports
 * `answer = add(40, 2)` (42).
 *
 * NOTE: this runs vite in the Node lane (the repo's installed vite 7.3.6).
 * The headed-Firefox browser lane is the intended consumption path, but the
 * M3 E2E harness is down with a pre-existing 883:26 bootstrap failure
 * (fails on base main too, unrelated to this work). These assertions pin
 * the OUTPUT CONTRACT so the browser run inherits them once the harness
 * is fixed. minify:"esbuild" hangs in the browser per the M3 docs; the
 * working browser paths are minify:false and minify:"terser".
 */

const FIXTURE = {
  "src/add.js": "export function add(a, b) { return a + b; }\n",
  "src/main.js":
    "import { add } from './add.js';\nexport const answer = add(40, 2);\n",
};

let dirs = {};
beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vite7-m3-output-"));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  for (const minify of [false, "esbuild"]) {
    const tag = minify === false ? "nominify" : minify;
    const outDir = path.join(root, "dist-" + tag);
    await build({
      root,
      logLevel: "silent",
      build: {
        outDir,
        emptyOutDir: true,
        minify,
        lib: {
          entry: path.join(root, "src/main.js"),
          formats: ["es"],
          fileName: () => "bundle.js",
        },
      },
    });
    dirs[tag] = outDir;
  }
}, 120000);

function jsFiles(tag) {
  return fs
    .readdirSync(dirs[tag])
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(dirs[tag], f));
}

describe("M3 output: vite.build() emits exactly 1 chunk", () => {
  test("minify:false emits a single JS chunk", () => {
    expect(jsFiles("nominify")).toHaveLength(1);
  });

  test("minified emits a single JS chunk", () => {
    expect(jsFiles("esbuild")).toHaveLength(1);
  });
});

describe("M3 output: chunk executes with real behavior", () => {
  test("unminified chunk exports answer = 42", async () => {
    const ns = await import(pathToFileURL(jsFiles("nominify")[0]).href);
    expect(ns.answer).toBe(42);
  });

  test("minified chunk exports answer = 42", async () => {
    const ns = await import(pathToFileURL(jsFiles("esbuild")[0]).href);
    expect(ns.answer).toBe(42);
  });

  test("expected exports present (answer)", async () => {
    for (const tag of ["nominify", "esbuild"]) {
      const ns = await import(pathToFileURL(jsFiles(tag)[0]).href);
      expect(Object.keys(ns)).toContain("answer");
    }
  });
});

describe("M3 output: minified < unminified", () => {
  test("minified bundle is smaller than unminified", () => {
    const mini = fs.statSync(jsFiles("esbuild")[0]).size;
    const full = fs.statSync(jsFiles("nominify")[0]).size;
    expect(mini).toBeLessThan(full);
  });
});
