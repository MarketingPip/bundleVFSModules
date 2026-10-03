import { describe, test, expect } from "@jest/globals";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const SEED_SCRIPT = path.join(REPO, "scripts", "build-vite-seed.mjs");
const OUT = "/tmp/test-vite-seed-worker.json";

/**
 * The WASI worker (@rolldown/browser/dist/wasi-worker-browser.mjs) is
 * inlined as a data: URL by inlineWasmDataUrls (runtime.js). A data: URL
 * worker cannot resolve bare imports ('@napi-rs/wasm-runtime'), so the
 * seed must contain a pre-bundled, self-contained worker.
 *
 * RED-first: the vite seed builder does not bundle the worker yet.
 */
describe("vite seed WASI worker bundling", () => {
  test("seed worker entry has no bare imports", () => {
    execSync(`node ${SEED_SCRIPT} ${OUT}`, { stdio: "pipe" });
    const seed = JSON.parse(fs.readFileSync(OUT, "utf8"));
    const workerKey =
      "/node_modules/@rolldown/browser/dist/wasi-worker-browser.mjs";
    const worker = seed[workerKey];
    expect(typeof worker).toBe("string");
    // No bare-specifier imports (quoted strings that look like package names).
    // String literals in error messages are fine; real imports are not.
    const importRe = /^\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm;
    const bare = [];
    let m;
    while ((m = importRe.exec(worker)) !== null) {
      const spec = m[1];
      if (!spec.startsWith(".") && !spec.startsWith("data:")) bare.push(spec);
    }
    expect(bare).toEqual([]);
    fs.unlinkSync(OUT);
  }, 120000);
});
