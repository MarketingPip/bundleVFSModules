// E2E: serve-time WASM inlining produces an executable rollup build.
//
// The parent _dynamic_import handler serves rollup.browser.js with the WASM
// inlined as a data: URL at SERVE time (no seed-time source patch). This
// test proves the full chain on the real artifacts: extract the live
// inlineWasmDataUrls helper from runtime.js, serve the raw ESM + WASM
// envelope exactly as the new seed provides them, import the served module,
// and run a real rollup() bundle (which forces WASM instantiation — the
// parser is WASM-backed). If the inlined bytes were corrupt, the bundle
// would fail.
import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);
const NM = path.join(__dirname, "..", "node_modules");

// Mirror of the new (unpatched) seed: raw ESM + wasm binary envelope.
const ROLLUP_ESM = fs.readFileSync(
  path.join(NM, "@rollup/browser", "dist", "es", "rollup.browser.js"),
  "utf8",
);
const WASM_B64 = fs
  .readFileSync(
    path.join(NM, "@rollup/browser", "dist", "bindings_wasm_bg.wasm"),
  )
  .toString("base64");
const FLAT = {
  "/node_modules/@rollup/browser/dist/es/rollup.browser.js": ROLLUP_ESM,
  "/node_modules/@rollup/browser/dist/es/bindings_wasm_bg.wasm": {
    encoding: "base64",
    data: WASM_B64,
  },
};

// Extract the live handler exactly like tests/vite7-dynamic-import.test.js.

describe("wasm data-url E2E: served rollup build executes", () => {
  test("served source has data: URL, executes, and bundles via WASM", async () => {
    // Simpler robust path: replicate the handler's serve() logic through the
    // unit-tested helper — extract inlineWasmDataUrls + interception table.
    const helperSrc = RUNTIME_SRC.slice(
      RUNTIME_SRC.indexOf("function inlineWasmDataUrls("),
      RUNTIME_SRC.indexOf("function toVFSPath("),
    );
    const helper = new Function(`${helperSrc}\nreturn inlineWasmDataUrls;`)();
    const unflatten = (flat) => {
      // Minimal unflatten: only the two paths we seed.
      const esm =
        flat["/node_modules/@rollup/browser/dist/es/rollup.browser.js"];
      const wasm =
        flat["/node_modules/@rollup/browser/dist/es/bindings_wasm_bg.wasm"];
      return {
        node_modules: {
          "@rollup": {
            browser: {
              dist: {
                es: {
                  "rollup.browser.js": esm,
                  "bindings_wasm_bg.wasm": wasm,
                },
              },
            },
          },
        },
      };
    };
    const vfs = unflatten(FLAT);
    const served = helper(
      ROLLUP_ESM,
      "/node_modules/@rollup/browser/dist/es/rollup.browser.js",
      vfs,
    );
    expect(served).toContain("data:application/wasm;base64,");
    expect(served).not.toContain(
      'new URL("bindings_wasm_bg.wasm",import.meta.url)',
    );

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task1-e2e-"));
    const modPath = path.join(dir, "rollup.browser.js");
    fs.writeFileSync(modPath, served);
    const mod = await import(pathToFileURL(modPath).href);
    expect(typeof mod.rollup).toBe("function");

    // Real bundle: forces WASM instantiation (the parser is WASM-backed).
    const bundle = await mod.rollup({
      input: "virtual-entry",
      plugins: [
        {
          name: "virtual",
          resolveId(id) {
            return id === "virtual-entry" ? id : null;
          },
          load(id) {
            return id === "virtual-entry"
              ? "export const answer = 40 + 2;"
              : null;
          },
        },
      ],
      onwarn() {},
    });
    const { output } = await bundle.generate({ format: "es" });
    const code = output.map((o) => o.code || "").join("\n");
    expect(code).toContain("answer");
    await bundle.close();
  }, 120000);
});
