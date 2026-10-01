import { describe, test, expect } from "@jest/globals";
import { WASI } from "../src/wasi.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Clang hello-world WASI spike (2026-10-01).
 *
 * Proves src/wasi.js can execute a WASI preview1 "hello world" binary:
 * the module calls fd_write(1, iovs, 1, nwritten) to print "hello world\n"
 * to stdout, then proc_exit(0).
 *
 * The WASM binary is hand-assembled (see scripts/build-hello-wasi.py) —
 * the spike validates the runtime integration, not the Clang toolchain.
 * A Clang-compiled binary would use the same WASI preview1 ABI.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "fixtures", "hello-wasi.wasm");

describe("WASI hello-world spike", () => {
  test("fixture exists and is valid WASM", async () => {
    expect(fs.existsSync(WASM_PATH)).toBe(true);
    const bytes = fs.readFileSync(WASM_PATH);
    const mod = await WebAssembly.compile(bytes);
    const imports = WebAssembly.Module.imports(mod);
    expect(imports).toContainEqual({
      module: "wasi_snapshot_preview1",
      name: "fd_write",
      kind: "function",
    });
    const exports = WebAssembly.Module.exports(mod);
    expect(exports).toContainEqual({ name: "_start", kind: "function" });
    expect(exports).toContainEqual({ name: "memory", kind: "memory" });
  });

  test("WASI _start writes 'hello world' to stdout and exits 0", async () => {
    const bytes = fs.readFileSync(WASM_PATH);

    // Capture console.log BEFORE constructing WASI (shim binds at construction)
    let stdout = "";
    const origLog = console.log;
    console.log = (...args) => {
      stdout += args.join(" ") + "\n";
    };

    try {
      const wasi = new WASI({
        version: "preview1",
        args: [],
        env: {},
        returnOnExit: true,
      });
      const mod = await WebAssembly.compile(bytes);
      const instance = await WebAssembly.instantiate(
        mod,
        wasi.getImportObject(),
      );
      const exitCode = wasi.start(instance);
      expect(exitCode).toBe(0);
    } finally {
      console.log = origLog;
    }

    expect(stdout).toContain("hello world");
  });
});
