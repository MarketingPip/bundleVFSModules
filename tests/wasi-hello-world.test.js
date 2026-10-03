import { describe, test, expect } from "@jest/globals";
import { WASI } from "../src/wasi.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Clang hello-world WASI spike (2026-10-03).
 *
 * Proves src/wasi.js can execute a REAL Clang-produced WASI preview1
 * binary: tests/fixtures/hello-wasi.wasm compiled from
 * tests/fixtures/hello.c with wasi-sdk 25.0 (Clang 19.1.5,
 * --target=wasm32-wasi).
 *
 * Rebuild: scripts/build-clang-wasi.sh (pins the toolchain, uses
 * $WASI_SDK_PATH). The old hand-assembled fixture
 * (scripts/build-hello-wasi.py, 184 bytes) is retired by this spike.
 *
 * The C program exercises what a hand-assembled module cannot: libc
 * startup, malloc/free, snprintf formatting, and argc/argv via
 * args_sizes_get/args_get. Expected stdout with
 * args ["hello.wasm", "foo", "bar"]:
 *   clang-wasi-hello
 *   argc=3
 *   argv[0]=hello.wasm
 *   argv[1]=foo
 *   argv[2]=bar
 *   fib(20)=6765
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "fixtures", "hello-wasi.wasm");

describe("WASI Clang hello-world spike", () => {
  test("fixture exists and is valid WASM", async () => {
    expect(fs.existsSync(WASM_PATH)).toBe(true);
    const bytes = fs.readFileSync(WASM_PATH);
    const mod = await WebAssembly.compile(bytes);
    const imports = WebAssembly.Module.imports(mod);
    // Genuine Clang output imports multiple preview1 syscalls, not just fd_write
    const names = imports
      .filter((i) => i.module === "wasi_snapshot_preview1")
      .map((i) => i.name);
    for (const fn of ["args_get", "args_sizes_get", "fd_write", "proc_exit"]) {
      expect(names).toContain(fn);
    }
    const exports = WebAssembly.Module.exports(mod);
    expect(exports).toContainEqual({ name: "_start", kind: "function" });
    expect(exports).toContainEqual({ name: "memory", kind: "memory" });
  });

  test("Clang _start prints argc/argv + fib(20) to stdout and exits 0", async () => {
    const bytes = fs.readFileSync(WASM_PATH);

    // Capture console.log BEFORE constructing WASI (shim binds at construction)
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => {
      lines.push(args.join(" "));
    };

    try {
      const wasi = new WASI({
        version: "preview1",
        args: ["hello.wasm", "foo", "bar"],
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

    const stdout = lines.join("\n");
    expect(stdout).toContain("clang-wasi-hello");
    expect(stdout).toContain("argc=3");
    expect(stdout).toContain("argv[0]=hello.wasm");
    expect(stdout).toContain("argv[1]=foo");
    expect(stdout).toContain("argv[2]=bar");
    expect(stdout).toContain("fib(20)=6765");
  });
});
