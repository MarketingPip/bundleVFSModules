import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runWasi } from "../src/runtime/runwasi.js";

/**
 * runWasi() — first-class host API for wasm32-wasi execution (roadmap §1).
 *
 * Tests the real pipeline: runWasi() -> WASI wrapper (src/wasi.js) ->
 * @bjorn3/browser_wasi_shim preview1 engine -> WebAssembly. No mocks:
 * the Clang fixture is a genuine wasi-sdk binary, and the file-reader
 * module below is hand-assembled WASM exercising real WASI syscalls
 * (path_open / fd_read / fd_write / environ_*).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "hello-wasi.wasm");

// ---------------------------------------------------------------------------
// Minimal WASM emitter (for the file-reader / env-dumper test module)
// ---------------------------------------------------------------------------

function uleb(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

function sleb(n) {
  const out = [];
  let more = true;
  while (more) {
    let b = n & 0x7f;
    n >>= 7;
    const sign = b & 0x40;
    if ((n === 0 && sign === 0) || (n === -1 && sign !== 0)) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return out;
}

const str = (s) => {
  const b = new TextEncoder().encode(s);
  return [...uleb(b.length), ...b];
};
const vec = (items) => [...uleb(items.length), ...items.flat()];

function i32c(n) {
  return [0x41, ...sleb(n)];
}
function i64c(n) {
  return [0x42, ...sleb(n)];
}
const i32load = (off) => [0x28, ...uleb(2), ...uleb(off)];
const i32store = (off) => [0x36, ...uleb(2), ...uleb(off)];
const call = (i) => [0x10, ...uleb(i)];
const DROP = [0x1a];

/**
 * Hand-assembled WASI module. Imports path_open/fd_read/fd_write/
 * environ_sizes_get/environ_get from wasi_snapshot_preview1, exports
 * memory (2 pages) and _start. _start:
 *   1. opens "input.txt" (preopen fd 3 = /sandbox), reads it, echoes to stdout
 *   2. creates "output.txt", writes "wrote-it\n"
 *   3. dumps the environ block to stdout
 *   4. writes "stderr-mark\n" to stderr (fd 2)
 */
function buildFileReaderWasm() {
  const bytes = [];
  const push = (...xs) => bytes.push(...xs);

  push(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00); // magic+version

  // type section
  const t0 = [
    0x60,
    ...uleb(9),
    0x7f,
    0x7f,
    0x7f,
    0x7f,
    0x7f,
    0x7e,
    0x7e,
    0x7f,
    0x7f,
    ...uleb(1),
    0x7f,
  ]; // path_open (i64 = 0x7e)
  const t1 = [0x60, ...uleb(4), 0x7f, 0x7f, 0x7f, 0x7f, ...uleb(1), 0x7f]; // fd_*
  const t2 = [0x60, ...uleb(0), ...uleb(0)]; // _start
  const t3 = [0x60, ...uleb(2), 0x7f, 0x7f, ...uleb(1), 0x7f]; // environ_*
  push(0x01, ...uleb(vec([t0, t1, t2, t3]).length), ...vec([t0, t1, t2, t3]));

  // import section
  const imp = (name, tidx) => [
    ...str("wasi_snapshot_preview1"),
    ...str(name),
    0x00,
    ...uleb(tidx),
  ];
  const imports = vec([
    imp("path_open", 0),
    imp("fd_read", 1),
    imp("fd_write", 1),
    imp("environ_sizes_get", 3),
    imp("environ_get", 3),
  ]);
  push(0x02, ...uleb(imports.length), ...imports);

  // function section: _start is func 5, type 2
  push(0x03, ...uleb(2), ...vec([[0x02]]));

  // memory section: min 2 pages
  push(0x05, ...uleb(3), ...vec([[...uleb(0), ...uleb(2)]]));

  // export section
  const exp = (name, kind, idx) => [...str(name), kind, ...uleb(idx)];
  const exports = vec([exp("memory", 0x02, 0), exp("_start", 0x00, 5)]);
  push(0x07, ...uleb(exports.length), ...exports);

  // code section
  const body = [
    // open "input.txt" @64 len 9 -> fd @16
    ...i32c(3),
    ...i32c(0),
    ...i32c(64),
    ...i32c(9),
    ...i32c(0),
    ...i64c(-1),
    ...i64c(-1),
    ...i32c(0),
    ...i32c(16),
    ...call(0),
    ...DROP,
    // iov0 = {buf:256, len:128} @32
    ...i32c(32),
    ...i32c(256),
    ...i32store(0),
    ...i32c(36),
    ...i32c(128),
    ...i32store(0),
    // fd_read([16], 32, 1, 24)
    ...i32c(16),
    ...i32load(0),
    ...i32c(32),
    ...i32c(1),
    ...i32c(24),
    ...call(1),
    ...DROP,
    // fd_write(1, 32, 1, 28) — echo file to stdout
    ...i32c(1),
    ...i32c(32),
    ...i32c(1),
    ...i32c(28),
    ...call(2),
    ...DROP,
    // open "output.txt" @80 len 10, CREAT|TRUNC -> fd @20
    ...i32c(3),
    ...i32c(0),
    ...i32c(80),
    ...i32c(10),
    ...i32c(9),
    ...i64c(-1),
    ...i64c(-1),
    ...i32c(0),
    ...i32c(20),
    ...call(0),
    ...DROP,
    // iov1 = {buf:96, len:9} @48 — "wrote-it\n" @96
    ...i32c(48),
    ...i32c(96),
    ...i32store(0),
    ...i32c(52),
    ...i32c(9),
    ...i32store(0),
    // fd_write([20], 48, 1, 28)
    ...i32c(20),
    ...i32load(0),
    ...i32c(48),
    ...i32c(1),
    ...i32c(28),
    ...call(2),
    ...DROP,
    // environ_sizes_get(40, 44)
    ...i32c(40),
    ...i32c(44),
    ...call(3),
    ...DROP,
    // environ_get(512, 1024)
    ...i32c(512),
    ...i32c(1024),
    ...call(4),
    ...DROP,
    // iov0 = {buf:1024, len:[44]}
    ...i32c(32),
    ...i32c(1024),
    ...i32store(0),
    ...i32c(36),
    ...i32c(44),
    ...i32load(0),
    ...i32store(0),
    // fd_write(1, 32, 1, 28) — dump environ
    ...i32c(1),
    ...i32c(32),
    ...i32c(1),
    ...i32c(28),
    ...call(2),
    ...DROP,
    // stderr marker: iov0 = {buf:112, len:12} — "stderr-mark\n" @112
    ...i32c(32),
    ...i32c(112),
    ...i32store(0),
    ...i32c(36),
    ...i32c(12),
    ...i32store(0),
    ...i32c(2),
    ...i32c(32),
    ...i32c(1),
    ...i32c(28),
    ...call(2),
    ...DROP,
    0x0b,
  ];
  const funcBody = [...uleb(0), ...body]; // 0 locals
  const func = [...uleb(funcBody.length), ...funcBody];
  const code = vec([func]);
  push(0x0a, ...uleb(code.length), ...code);

  // data section
  const seg = (off, s) => {
    const b = new TextEncoder().encode(s);
    return [0x00, ...i32c(off), 0x0b, ...uleb(b.length), ...b];
  };
  const data = vec([
    seg(64, "input.txt"),
    seg(80, "output.txt"),
    seg(96, "wrote-it\n"),
    seg(112, "stderr-mark\n"),
  ]);
  push(0x0b, ...uleb(data.length), ...data);

  return new Uint8Array(bytes);
}

/**
 * Minimal WASI module whose _start calls proc_exit(code) immediately.
 * Proves returnOnExit semantics: the exit code flows back through
 * start() instead of throwing.
 */
function buildExitWasm(code) {
  const bytes = [];
  const push = (...xs) => bytes.push(...xs);
  push(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00); // magic+version
  // types: 0 = (i32)->(), 1 = ()->()
  const t0 = [0x60, ...uleb(1), 0x7f, ...uleb(0)];
  const t1 = [0x60, ...uleb(0), ...uleb(0)];
  push(0x01, ...uleb(vec([t0, t1]).length), ...vec([t0, t1]));
  // import section: proc_exit : type 0
  const imp = [
    ...str("wasi_snapshot_preview1"),
    ...str("proc_exit"),
    0x00,
    ...uleb(0),
  ];
  const imports = vec([imp]);
  push(0x02, ...uleb(imports.length), ...imports);
  // function section: func 1 (=_start) : type 1
  push(0x03, ...uleb(2), ...vec([[0x01]]));
  // memory section: min 1 page (harmless; keeps engines happy)
  push(0x05, ...uleb(3), ...vec([[...uleb(0), ...uleb(1)]]));
  // export section: memory -> mem 0, _start -> func 1
  const exps = vec([
    [...str("memory"), 0x02, ...uleb(0)],
    [...str("_start"), 0x00, ...uleb(1)],
  ]);
  push(0x07, ...uleb(exps.length), ...exps);
  // code section: _start = { i32.const code; call proc_exit }
  const body = [...i32c(code), ...call(0), 0x0b];
  const funcBody = [...uleb(0), ...body];
  const func = [...uleb(funcBody.length), ...funcBody];
  const codeSec = vec([func]);
  push(0x0a, ...uleb(codeSec.length), ...codeSec);
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runWasi — first-class WASI host API", () => {
  test("is exported and validates bytes", async () => {
    expect(typeof runWasi).toBe("function");
    await expect(runWasi(null)).rejects.toThrow();
    await expect(runWasi("not-bytes")).rejects.toThrow();
    await expect(runWasi(new Uint8Array([0, 1, 2]))).rejects.toThrow();
  });

  test("real Clang fixture: exit code 0 and stdout", async () => {
    const bytes = new Uint8Array(fs.readFileSync(FIXTURE));
    const r = await runWasi(bytes, {
      args: ["hello.wasm", "foo", "bar"],
      env: {},
    });
    expect(r.exitCode).toBe(0);
    const out = r.stdout.join("\n");
    expect(out).toContain("clang-wasi-hello");
    expect(out).toContain("argc=3");
    expect(out).toContain("argv[1]=foo");
    expect(out).toContain("fib(20)=6765");
  }, 30000);

  test("args are passed through (argv[0] is program name)", async () => {
    const bytes = new Uint8Array(fs.readFileSync(FIXTURE));
    const r = await runWasi(bytes, { args: ["prog", "a", "b", "c"] });
    expect(r.exitCode).toBe(0);
    const out = r.stdout.join("\n");
    expect(out).toContain("argc=4");
    expect(out).toContain("argv[0]=prog");
    expect(out).toContain("argv[3]=c");
  }, 30000);

  test("guest reads a VFS-seeded file and env reaches the guest", async () => {
    const mod = buildFileReaderWasm();
    // sanity: the hand-assembled module is valid wasm
    expect(WebAssembly.validate(mod)).toBe(true);
    const r = await runWasi(mod, {
      env: { GREETING: "hi-from-env" },
      files: { "/input.txt": "vfs-hello\n" },
    });
    expect(r.exitCode).toBe(0);
    const out = r.stdout.join("\n");
    // file content echoed by the guest via path_open/fd_read
    expect(out).toContain("vfs-hello");
    // environ block reached the guest
    expect(out).toContain("GREETING=hi-from-env");
    // stderr captured separately
    expect(r.stderr.join("\n")).toContain("stderr-mark");
    expect(out).not.toContain("stderr-mark");
  }, 30000);

  test("guest file writes are captured in the returned files snapshot", async () => {
    const mod = buildFileReaderWasm();
    const r = await runWasi(mod, { files: { "/input.txt": "x\n" } });
    expect(r.exitCode).toBe(0);
    expect(r.files["/output.txt"]).toBeDefined();
    const text = new TextDecoder().decode(r.files["/output.txt"]);
    expect(text).toBe("wrote-it\n");
  }, 30000);

  test("empty env and no files still run", async () => {
    const bytes = new Uint8Array(fs.readFileSync(FIXTURE));
    const r = await runWasi(bytes);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.join("\n")).toContain("clang-wasi-hello");
  }, 30000);

  test("non-zero exit code flows back via returnOnExit", async () => {
    const mod = buildExitWasm(42);
    expect(WebAssembly.validate(mod)).toBe(true);
    const r = await runWasi(mod);
    expect(r.exitCode).toBe(42);
    expect(r.stdout).toEqual([]);
    expect(r.stderr).toEqual([]);
  }, 30000);

  test("opts validation rejects bad args/env/preopenDir", async () => {
    const bytes = new Uint8Array(fs.readFileSync(FIXTURE));
    await expect(runWasi(bytes, { args: "nope" })).rejects.toThrow(/args/);
    await expect(runWasi(bytes, { args: [1] })).rejects.toThrow(/args/);
    await expect(runWasi(bytes, { env: "nope" })).rejects.toThrow(/env/);
    await expect(runWasi(bytes, { env: null })).rejects.toThrow(/env/);
    await expect(runWasi(bytes, { files: "nope" })).rejects.toThrow(/files/);
    await expect(runWasi(bytes, { preopenDir: "relative" })).rejects.toThrow(
      /preopenDir/,
    );
  }, 30000);
});
