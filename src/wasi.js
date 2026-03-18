// npm install @bjorn3/browser_wasi_shim

/*!
 * wasi-web — node:wasi for browsers & bundlers
 * MIT License.
 * Node.js parity: node:wasi @ Node 12.16.0+ (preview1 + unstable)
 * Dependencies: @bjorn3/browser_wasi_shim
 * Limitations:
 *   - preopens map virtual paths to in-memory empty directories; real host
 *     filesystem paths are ignored (no access in browser context).
 *   - stdin is an empty read-only File; interactive stdin is not supported.
 *   - stdout / stderr are line-buffered to console.log / console.error.
 *   - returnOnExit=false has no process.exit() equivalent; throws instead.
 *   - finalizeBindings() sets inst on the inner shim directly — internal API.
 *   - No DNSSEC / socket syscalls (not part of preview1 spec).
 */

/**
 * @packageDocumentation
 * Implements `node:wasi` for browser and bundler environments.
 *
 * Uses `@bjorn3/browser_wasi_shim` for the preview1 / unstable syscall ABI,
 * wrapped in a class that matches Node's WASI API exactly:
 *   - Constructor options: version, args, env, preopens, returnOnExit,
 *     stdin, stdout, stderr (fd numbers accepted; mapped to console I/O).
 *   - `wasi.getImportObject()` — ready for `WebAssembly.instantiate()`.
 *   - `wasi.start(instance)`  — WASI command entry (_start).
 *   - `wasi.initialize(instance)` — WASI reactor entry (_initialize).
 *   - `wasi.finalizeBindings(instance, options?)` — bind without entry call.
 *   - `wasi.wasiImport` — raw syscall object for manual instantiation.
 */

import {
  WASI as _BrowserWASI,
  File,
  OpenFile,
  ConsoleStdout,
  PreopenDirectory,
} from '@bjorn3/browser_wasi_shim';

// ---------------------------------------------------------------------------
// Private symbols — mirror Node's internal slot pattern
// ---------------------------------------------------------------------------

const kExitCode    = Symbol('kExitCode');
const kStarted     = Symbol('kStarted');
const kInstance    = Symbol('kInstance');
const kBindingName = Symbol('kBindingName');
const kInner       = Symbol('kInner');       // @bjorn3/browser_wasi_shim WASI instance

/**
 * Sentinel thrown by proc_exit when returnOnExit=true.
 * WebAssembly cannot catch JS symbols, so this safely unwinds the wasm stack.
 */
const kExitSentinel = Symbol('kExitSentinel');

// ---------------------------------------------------------------------------
// Internal error helpers — match Node's ERR_* code shape
// ---------------------------------------------------------------------------

/**
 * @param {string} name
 * @param {any} value
 * @param {string} reason
 * @returns {TypeError}
 */
function errInvalidArgValue(name, value, reason) {
  const msg = `The value of "${name}" is invalid. Received ${JSON.stringify(value)}${reason ? `: ${reason}` : ''}`;
  return Object.assign(new TypeError(msg), { code: 'ERR_INVALID_ARG_VALUE' });
}

/**
 * @returns {Error}
 */
function errWasiAlreadyStarted() {
  return Object.assign(
    new Error('WASI instance has already started or had its bindings finalized'),
    { code: 'ERR_WASI_ALREADY_STARTED' },
  );
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** @param {unknown} v @param {string} name */
function validateString(v, name) {
  if (typeof v !== 'string')
    throw Object.assign(
      new TypeError(`The "${name}" argument must be of type string. Received type ${typeof v}`),
      { code: 'ERR_INVALID_ARG_TYPE' },
    );
}

/** @param {unknown} v @param {string} name */
function validateObject(v, name) {
  if (v === null || typeof v !== 'object')
    throw Object.assign(
      new TypeError(`The "${name}" argument must be of type object. Received type ${typeof v}`),
      { code: 'ERR_INVALID_ARG_TYPE' },
    );
}

/** @param {unknown} v @param {string} name */
function validateArray(v, name) {
  if (!Array.isArray(v))
    throw Object.assign(
      new TypeError(`The "${name}" argument must be an instance of Array. Received type ${typeof v}`),
      { code: 'ERR_INVALID_ARG_TYPE' },
    );
}

/** @param {unknown} v @param {string} name */
function validateBoolean(v, name) {
  if (typeof v !== 'boolean')
    throw Object.assign(
      new TypeError(`The "${name}" argument must be of type boolean. Received type ${typeof v}`),
      { code: 'ERR_INVALID_ARG_TYPE' },
    );
}

/** @param {unknown} v @param {string} name */
function validateFunction(v, name) {
  if (typeof v !== 'function')
    throw Object.assign(
      new TypeError(`The "${name}" argument must be of type function. Received type ${typeof v}`),
      { code: 'ERR_INVALID_ARG_TYPE' },
    );
}

/** @param {unknown} v @param {string} name */
function validateUndefined(v, name) {
  if (v !== undefined)
    throw Object.assign(
      new TypeError(`The "${name}" argument must be undefined. Received type ${typeof v}`),
      { code: 'ERR_INVALID_ARG_TYPE' },
    );
}

// ---------------------------------------------------------------------------
// WASI class
// ---------------------------------------------------------------------------

/**
 * Browser-compatible WASI runtime host.
 * Wraps `@bjorn3/browser_wasi_shim` in Node's `node:wasi` class shape.
 *
 * @example
 * import { WASI } from './wasi';
 *
 * const wasi = new WASI({ version: 'preview1', args: ['app.wasm'] });
 * const wasm = await WebAssembly.compileStreaming(fetch('/app.wasm'));
 * const instance = await WebAssembly.instantiate(wasm, wasi.getImportObject());
 * wasi.start(instance);
 */
export class WASI {
  /**
   * @param {{
   *   version:       'preview1' | 'unstable';
   *   args?:         string[];
   *   env?:          Record<string, string | undefined>;
   *   preopens?:     Record<string, string>;
   *   returnOnExit?: boolean;
   *   stdin?:        number;
   *   stdout?:       number;
   *   stderr?:       number;
   * }} [options]
   */
  constructor(options = {}) {
    validateObject(options, 'options');

    // ── version (required, no default since Node 20) ──────────────────────
    validateString(options.version, 'options.version');
    switch (options.version) {
      case 'unstable': this[kBindingName] = 'wasi_unstable';          break;
      case 'preview1': this[kBindingName] = 'wasi_snapshot_preview1'; break;
      default:
        throw errInvalidArgValue('options.version', options.version, 'unsupported WASI version');
    }

    // ── args ──────────────────────────────────────────────────────────────
    if (options.args !== undefined) validateArray(options.args, 'options.args');
    const args = (options.args ?? []).map(String);

    // ── env — serialised as KEY=VALUE strings ─────────────────────────────
    const env = [];
    if (options.env !== undefined) {
      validateObject(options.env, 'options.env');
      if (Array.isArray(options.env)) {
        throw Object.assign(
          new TypeError(`The "options.env" argument must be of type object. Received type array`),
          { code: 'ERR_INVALID_ARG_TYPE' }
        );
      }
      for (const [k, v] of Object.entries(options.env)) {
        if (v !== undefined) env.push(`${k}=${v}`);
      }
    }

    // ── stdio — node options take fd numbers; we map to console I/O ───────
    // (stdin fd 0 becomes an empty readable File; stdout/stderr go to console)
    // The fd integer values are validated but otherwise unused in browser ctx.
    if (options.stdin  !== undefined && !Number.isInteger(options.stdin))
      throw Object.assign(new RangeError('options.stdin must be an integer'), { code: 'ERR_INVALID_ARG_TYPE' });
    if (options.stdout !== undefined && !Number.isInteger(options.stdout))
      throw Object.assign(new RangeError('options.stdout must be an integer'), { code: 'ERR_INVALID_ARG_TYPE' });
    if (options.stderr !== undefined && !Number.isInteger(options.stderr))
      throw Object.assign(new RangeError('options.stderr must be an integer'), { code: 'ERR_INVALID_ARG_TYPE' });

    /** @type {import('@bjorn3/browser_wasi_shim').Fd[]} */
    const fds = [
      new OpenFile(new File([])),                                           // fd 0: stdin  (empty)
      ConsoleStdout.lineBuffered(line => console.log(line)),                // fd 1: stdout
      ConsoleStdout.lineBuffered(line => console.error(line)),              // fd 2: stderr
    ];

    // ── preopens — virtual directories in browser context ─────────────────
    if (options.preopens !== undefined) {
      validateObject(options.preopens, 'options.preopens');
      for (const [vpath] of Object.entries(options.preopens)) {
        // Real host paths are meaningless in browser; mount empty virtual dirs.
        // WASM modules may still create / populate files inside them at runtime.
        fds.push(new PreopenDirectory(vpath, new Map()));
      }
    }

    // ── Create the underlying browser WASI shim ───────────────────────────
    this[kInner] = new _BrowserWASI(args, env, fds);

    // ── returnOnExit ──────────────────────────────────────────────────────
    let returnOnExit = true;
    if (options.returnOnExit !== undefined) {
      validateBoolean(options.returnOnExit, 'options.returnOnExit');
      returnOnExit = options.returnOnExit;
    }

    // ── Build wasiImport ──────────────────────────────────────────────────
    // Spread to get a plain object copy; functions remain bound to kInner so
    // memory access (via this.inst) still resolves correctly.
    const raw = this[kInner].wasiImport;
    const wasiImport = Object.create(null);
    for (const key of Object.keys(raw)) wasiImport[key] = raw[key];

    // Override proc_exit to match Node's returnOnExit behaviour.
    const self = this;
    if (returnOnExit) {
      // Throw the sentinel symbol — WebAssembly cannot catch JS symbols, so
      // this safely unwinds the entire wasm call stack back to start().
      wasiImport.proc_exit = function proc_exit(rval) {
        self[kExitCode] = rval >>> 0; // coerce to uint32 like POSIX
        throw kExitSentinel;
      };
    } else {
      // No process.exit() in browser — throw an Error that propagates to
      // the caller of start() as an unhandled exception.
      wasiImport.proc_exit = function proc_exit(rval) {
        throw Object.assign(
          new Error(`WASI: proc_exit called with code ${rval >>> 0}`),
          { code: 'WASI_EXIT', exitCode: rval >>> 0 },
        );
      };
    }

    this.wasiImport  = wasiImport;
    this[kStarted]   = false;
    this[kExitCode]  = 0;
    this[kInstance]  = undefined;
  }

  // ── finalizeBindings ──────────────────────────────────────────────────────

  /**
   * Binds the WASI instance to a WebAssembly instance without calling any
   * entry point. Useful for reactor sharing across threads.
   * Called internally by `start()` and `initialize()`.
   *
   * @param {WebAssembly.Instance} instance
   * @param {{ memory?: WebAssembly.Memory }} [options]
   */
  finalizeBindings(instance, {
    memory = instance?.exports?.memory,
  } = {}) {
    if (this[kStarted]) throw errWasiAlreadyStarted();

    validateObject(instance,         'instance');
    validateObject(instance.exports, 'instance.exports');

    if (!(memory instanceof WebAssembly.Memory))
      throw Object.assign(
        new TypeError('instance must export a WebAssembly.Memory named "memory"'),
        { code: 'ERR_INVALID_ARG_TYPE' },
      );

    // The browser shim reads memory via this.inst.exports.memory at syscall
    // time — setting inst here satisfies that without calling start/initialize.
    this[kInner].inst = instance;

    this[kInstance] = instance;
    this[kStarted]  = true;
  }

  // ── start ─────────────────────────────────────────────────────────────────

  /**
   * Starts a WASI *command* module. The instance must export `_start` and
   * must NOT export `_initialize`.
   *
   * @param {WebAssembly.Instance} instance
   * @returns {number} Exit code (0 on clean exit).
   */
  start(instance) {
    this.finalizeBindings(instance);

    const { _start, _initialize } = this[kInstance].exports;
    validateFunction(_start,     'instance.exports._start');
    validateUndefined(_initialize, 'instance.exports._initialize');

    try {
      _start();
    } catch (err) {
      if (err !== kExitSentinel) throw err;
    }

    return this[kExitCode];
  }

  // ── initialize ────────────────────────────────────────────────────────────

  /**
   * Initialises a WASI *reactor* module. The instance must NOT export `_start`;
   * it may optionally export `_initialize`.
   *
   * @param {WebAssembly.Instance} instance
   */
  initialize(instance) {
    this.finalizeBindings(instance);

    const { _start, _initialize } = this[kInstance].exports;
    validateUndefined(_start, 'instance.exports._start');

    if (_initialize !== undefined) {
      validateFunction(_initialize, 'instance.exports._initialize');
      _initialize();
    }
  }

  // ── getImportObject ───────────────────────────────────────────────────────

  /**
   * Returns an import object ready for `WebAssembly.instantiate()`.
   * Key is `wasi_snapshot_preview1` for preview1 or `wasi_unstable` for unstable.
   *
   * @returns {{ wasi_snapshot_preview1: object } | { wasi_unstable: object }}
   */
  getImportObject() {
    return { [this[kBindingName]]: this.wasiImport };
  }
}

export default { WASI };

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import { WASI } from './wasi';
//
// // ── WASI command (_start) ────────────────────────────────────────────────
// const wasi = new WASI({
//   version: 'preview1',
//   args: ['demo.wasm', '--flag'],
//   env: { HOME: '/home/user', PATH: '/usr/bin' },
//   preopens: { '/sandbox': '/irrelevant/in/browser' },
// });
// const wasm = await WebAssembly.compileStreaming(fetch('/demo.wasm'));
// const instance = await WebAssembly.instantiate(wasm, wasi.getImportObject());
// const exitCode = wasi.start(instance);
// console.log('exited with', exitCode);
//
// // ── WASI reactor (_initialize, no _start) ────────────────────────────────
// const wasiR = new WASI({ version: 'preview1' });
// const wasmR = await WebAssembly.compileStreaming(fetch('/lib.wasm'));
// const instR = await WebAssembly.instantiate(wasmR, wasiR.getImportObject());
// wasiR.initialize(instR);
// instR.exports.my_exported_fn(42);
//
// // ── finalizeBindings (shared memory / worker threads) ────────────────────
// const wasiT = new WASI({ version: 'preview1' });
// const mem   = new WebAssembly.Memory({ initial: 1, shared: true });
// const instT = await WebAssembly.instantiate(wasm, {
//   ...wasiT.getImportObject(),
//   env: { memory: mem },
// });
// wasiT.finalizeBindings(instT, { memory: mem });
//
// // ── returnOnExit=false — throws instead of returning ─────────────────────
// const wasiE = new WASI({ version: 'preview1', returnOnExit: false });
// const instE = await WebAssembly.instantiate(wasm, wasiE.getImportObject());
// try {
//   wasiE.start(instE);
// } catch (e) {
//   console.log(e.code, e.exitCode); // 'WASI_EXIT', <code>
// }
//
// // ── Edge: calling start() twice throws ERR_WASI_ALREADY_STARTED ──────────
// try {
//   wasi.start(instance);
// } catch (e) {
//   console.log(e.code); // 'ERR_WASI_ALREADY_STARTED'
// }
