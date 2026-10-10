/**
 * Reference toolchain plugin — TEST FIXTURE, NOT CORE.
 *
 * Implements the docs/TOOLCHAIN.md compile contract against a FAKE
 * compiler: it validates the input shape the way a real toolchain would,
 * then emits a hand-assembled wasm module instead of invoking clang.
 * Proves the registration/compile/resolution API end-to-end without
 * shipping any toolchain (roadmap §1: core never ships a toolchain).
 *
 * The emitted module exports:
 *   - `add(a, b)` (i32.add) — exercised through the "wasm" loader path
 *     (`import "./add.c"` → instance exports)
 *   - `_start` (empty) + `memory` (1 page) — so runWasi accepts the bytes
 *     as a wasm32-wasi command module (exit code 0)
 */

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

const str = (s) => {
  const b = new TextEncoder().encode(s);
  return [...uleb(b.length), ...b];
};
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, payload) => [id, ...uleb(payload.length), ...payload];

/**
 * Hand-assembled wasm module (no imports):
 *   type0: (i32,i32)->i32   type1: ()->()
 *   func0 = add (type0), func1 = _start (type1)
 *   memory 0: min 1 page
 *   exports: "add" func 0, "_start" func 1, "memory" mem 0
 */
export function buildStubWasm() {
  const bytes = [];
  const push = (...xs) => bytes.push(...xs);

  push(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00); // magic + version

  const t0 = [0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f]; // (i32,i32) -> i32
  const t1 = [0x60, 0x00, 0x00]; // () -> ()
  push(...section(0x01, vec([t0, t1])));

  push(...section(0x03, vec([[0x00], [0x01]]))); // funcs: add->t0, _start->t1
  push(...section(0x05, vec([[0x00, 0x01]]))); // 1 memory, min 1 page

  const exp = (name, kind, idx) => [...str(name), kind, ...uleb(idx)];
  push(
    ...section(
      0x07,
      vec([
        exp("add", 0x00, 0),
        exp("_start", 0x00, 1),
        exp("memory", 0x02, 0),
      ]),
    ),
  );

  // add body: local.get 0, local.get 1, i32.add, end
  const addBody = [0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b];
  // _start body: end (no-op)
  const startBody = [0x00, 0x0b];
  push(
    ...section(
      0x0a,
      vec([
        [...uleb(addBody.length), ...addBody],
        [...uleb(startBody.length), ...startBody],
      ]),
    ),
  );

  return new Uint8Array(bytes);
}

export const STUB_C_SOURCE = "int add(int a, int b) { return a + b; }\n";

/**
 * Build a stub toolchain record. The "compiler" checks that the entry
 * source defines the expected symbol and otherwise emits the canned wasm
 * module — the same shape of validation/error reporting a real toolchain
 * performs, without any real compilation.
 *
 * Options: { name, extensions, target, sysroot, expectPattern, exists,
 * readFile } — forwarded onto the record.
 */
export function createStubToolchain(overrides = {}) {
  const calls = [];
  const tc = {
    name: "stub-cc",
    target: "wasm32-wasi",
    extensions: [".c"],
    sysroot: { "/usr/include/stub.h": "int add(int a, int b);\n" },
    expectPattern: /int\s+add\s*\(/,
    ...overrides,
    calls,
    async compile(files, opts) {
      calls.push({ files: Object.keys(files), opts: { ...opts } });
      const entry = opts.entry ?? Object.keys(files)[0];
      const src = files[entry];
      if (src == null) {
        return {
          errors: [
            { file: entry, message: `stub-cc: no such file '${entry}'` },
          ],
        };
      }
      const text =
        typeof src === "string" ? src : new TextDecoder().decode(src);
      if (!tc.expectPattern.test(text)) {
        return {
          errors: [
            {
              file: entry,
              line: 1,
              column: 1,
              message:
                `stub-cc: expected a definition matching ${tc.expectPattern} ` +
                `(fake compiler — this is the contract's error path)`,
            },
          ],
        };
      }
      return {
        bytes: buildStubWasm(),
        warnings: [],
        stdout: `stub-cc: compiled ${entry} -> a.out.wasm\n`,
        stderr: "",
        elapsedMs: 1,
      };
    },
  };
  return tc;
}
