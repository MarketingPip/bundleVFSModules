import { describe, test, expect } from "@jest/globals";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const SEED_SCRIPT = path.join(REPO, "scripts", "build-vite-seed.mjs");
const OUT = "/tmp/test-vite-seed-fs-payload.json";

// Raised from the upstream 10KB: vite.build() inside the WASI binding
// returns fs responses (readdir listings, file reads) larger than 10KB,
// and writeResponsePayload throws RangeError('payload overflow').
const EXPECTED = 16 * 1024 * 1024;

/**
 * The WASI fs-proxy (@napi-rs/wasm-runtime/fs-proxy.js) caps single
 * responses at RESPONSE_PAYLOAD_SIZE (10KB upstream). Both sides of the
 * protocol use that constant: the main-thread createOnMessage (seeded
 * from the VFS) and the worker-side createFsProxy (esbuild-bundled into
 * the WASI worker). The seed builder must raise the limit in BOTH.
 *
 * RED-first: the seed builder does not patch the limit yet.
 */
describe("vite seed fs-proxy payload limit", () => {
  test("seeded fs-proxy.js has raised RESPONSE_PAYLOAD_SIZE", () => {
    execSync(`node ${SEED_SCRIPT} ${OUT}`, { stdio: "pipe" });
    const seed = JSON.parse(fs.readFileSync(OUT, "utf8"));
    const key = "/node_modules/@napi-rs/wasm-runtime/fs-proxy.js";
    const src = seed[key];
    expect(typeof src).toBe("string");
    const m = src.match(/const RESPONSE_PAYLOAD_SIZE = (\d+);?/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBe(EXPECTED);
    fs.unlinkSync(OUT);
  }, 180000);

  test("bundled WASI worker has raised RESPONSE_PAYLOAD_SIZE", () => {
    execSync(`node ${SEED_SCRIPT} ${OUT}`, { stdio: "pipe" });
    const seed = JSON.parse(fs.readFileSync(OUT, "utf8"));
    const workerKey =
      "/node_modules/@rolldown/browser/dist/wasi-worker-browser.mjs";
    const bundled = seed[workerKey];
    expect(typeof bundled).toBe("string");
    const m = bundled.match(/RESPONSE_PAYLOAD_SIZE\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBe(EXPECTED);
    fs.unlinkSync(OUT);
  }, 180000);
});
