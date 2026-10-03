/**
 * runWasi — first-class host API for wasm32-wasi execution (roadmap §1).
 *
 * Instantiates and runs a prebuilt wasm32-wasi (preview1) module against
 * a virtual filesystem, returning its exit code and captured stdio.
 * The toolchain plugin architecture (compile C → wasm bytes → run) builds
 * on this function; CodeSandbox.prototype.runWasi wires it to the
 * sandbox's config.fs.
 *
 * Environment-aware WASI loading (no bare specifiers leak into the
 * browser): under Node the wrapper is imported from ../wasi.js (npm
 * package resolves); in a browser host the prebuilt dist/wasi.js bundle
 * is used.
 */

let wasiClassPromise = null;

function loadWasiClass() {
  if (!wasiClassPromise) {
    wasiClassPromise = (async () => {
      const isNode =
        typeof process !== "undefined" &&
        process.versions &&
        typeof process.versions.node === "string";
      if (isNode) {
        return (await import("../wasi.js")).WASI;
      }
      return (await import("../../dist/wasi.js")).WASI;
    })();
  }
  return wasiClassPromise;
}

function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    bytes instanceof SharedArrayBuffer
  )
    return new Uint8Array(bytes);
  throw new TypeError(
    "runWasi(bytes): bytes must be a Uint8Array or ArrayBuffer. " +
      `Received ${Object.prototype.toString.call(bytes)}`,
  );
}

/**
 * Run a wasm32-wasi preview1 module.
 *
 * @param {Uint8Array|ArrayBuffer} bytes — the .wasm binary
 * @param {object} [opts]
 * @param {string[]} [opts.args] — argv (argv[0] should be the program name)
 * @param {Record<string,string>} [opts.env] — environment variables
 * @param {Record<string,string|Uint8Array>} [opts.files] — flat VFS seed,
 *   keys like "/input.txt"; mounted read/write at the guest preopen dir
 * @param {string} [opts.preopenDir] — guest mount point (default "/sandbox")
 * @returns {Promise<{exitCode:number, stdout:string[], stderr:string[],
 *   files:Record<string,Uint8Array>}>} — files is the post-run snapshot
 *   (seeded files reflect guest modifications; guest-created files included)
 */
export async function runWasi(bytes, opts = {}) {
  const wasmBytes = toUint8Array(bytes);
  if (wasmBytes.length < 8 || wasmBytes[0] !== 0x00 || wasmBytes[1] !== 0x61)
    throw new TypeError("runWasi(bytes): not a WebAssembly binary (bad magic)");

  const { args = [], env = {}, files = {}, preopenDir = "/sandbox" } = opts;
  if (!Array.isArray(args))
    throw new TypeError("runWasi: opts.args must be an array");
  if (args.some((a) => typeof a !== "string"))
    throw new TypeError("runWasi: opts.args must be strings");
  if (env === null || typeof env !== "object" || Array.isArray(env))
    throw new TypeError("runWasi: opts.env must be an object");
  if (files === null || typeof files !== "object" || Array.isArray(files))
    throw new TypeError("runWasi: opts.files must be an object");
  if (typeof preopenDir !== "string" || !preopenDir.startsWith("/"))
    throw new TypeError("runWasi: opts.preopenDir must be an absolute path");

  const WASI = await loadWasiClass();

  const stdout = [];
  const stderr = [];
  const wasi = new WASI({
    version: "preview1",
    args: args.map(String),
    env,
    preopens: { [preopenDir]: preopenDir },
    preopenFiles: { [preopenDir]: files },
    onStdout: (line) => stdout.push(line),
    onStderr: (line) => stderr.push(line),
    returnOnExit: true,
  });

  const mod = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(mod, wasi.getImportObject());
  const exitCode = wasi.start(instance);

  // Post-run VFS snapshot, mapped back to flat "/path" keys.
  const snap = wasi.readPreopenFiles()[preopenDir] || {};
  const outFiles = {};
  for (const [rel, data] of Object.entries(snap)) outFiles[`/${rel}`] = data;

  return { exitCode, stdout, stderr, files: outFiles };
}
