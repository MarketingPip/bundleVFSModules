/**
 * @packageDocumentation
 * Implements `node:wasi` for browser and bundler environments.
 *
 * Node.js v24.20.0 `lib/wasi.js` facade — constructor option validation
 * (`version`, `args`, `env`, `preopens`, `returnOnExit`, `stdin`, `stdout`,
 * `stderr`) is mirrored exactly, including the `ERR_*` codes and message
 * text — backed by the maintained `@bjorn3/browser_wasi_shim` WASI
 * preview1 engine instead of Node's native uvwasi binding:
 *
 *   - `wasi.getImportObject()` — ready for `WebAssembly.instantiate()`.
 *   - `wasi.start(instance)`  — WASI command entry (`_start`).
 *   - `wasi.initialize(instance)` — WASI reactor entry (`_initialize`).
 *   - `wasi.finalizeBindings(instance, options?)` — bind without entry call.
 *   - `wasi.wasiImport` — the preview1 syscall object for manual
 *     instantiation.
 *
 * What the engine provides over the old hand-rolled host: the full
 * preview1 ABI, including a real in-memory filesystem. `preopens` become
 * genuine virtual directories the guest can `path_open` / `fd_readdir` /
 * `fd_read` / `fd_write` against; `fd_seek`/`fd_tell`/`fd_filestat_get`
 * and friends work on real open-file state instead of returning NOSYS.
 *
 * A thin normalisation layer sits on top of the shim to preserve this
 * module's Node-exact edge semantics where the shim differs:
 *   - Syscalls need a bound instance (`finalizeBindings`/`start`/
 *     `initialize`); called earlier they return `__WASI_ERRNO_NOSYS`,
 *     as the old host did when no guest memory was attached.
 *   - `sched_yield()` returns `0` (the shim returns `undefined`).
 *   - `clock_time_get`/`clock_res_get` with an unknown clock id return
 *     `__WASI_ERRNO_INVAL`, matching Node/uvwasi (the shim reports
 *     success).
 *   - `fd_write` to the stdin fd and `fd_read` from a stdout/stderr fd
 *     return `__WASI_ERRNO_BADF` — stdio fds are directional, like Node's.
 *   - `proc_raise` and the `sock_*` family return `__WASI_ERRNO_NOSYS`
 *     instead of throwing strings: errno codes, never throws.
 *   - `proc_exit` honours `returnOnExit`: with `true` the exit code flows
 *     back through `start()`; with `false` (no `process.exit()` in a
 *     browser) it raises the `WASI_EXIT` error, as before.
 *
 * Known gaps vs Node (documented, not faked):
 *   - `preopens` values are kept as labels; there is no host filesystem in
 *     a browser, so Node's `UVWASI_ENOENT` validation of the host path
 *     cannot be reproduced. Each preopen is a fresh empty virtual
 *     directory.
 *   - `returnOnExit: false` cannot `process.exit()` in a browser; the
 *     guest's `proc_exit` surfaces as an `Error` with code `'WASI_EXIT'`
 *     instead of terminating anything.
 *   - Partial stdout/stderr lines (no trailing newline) are held by the
 *     engine's line buffer and never flushed; complete lines go to
 *     `console.log` / `console.error`.
 */

/* globalThis._RUNTIME_ is intentionally not used: this module needs no host
 * runtime services (no fs, no sockets, no process config). Everything it
 * touches — WebAssembly, TextEncoder/Decoder, crypto, performance, console —
 * is a plain global available in browsers and in Node. */

import {
  WASI as ShimWASI,
  File as ShimFile,
  OpenFile as ShimOpenFile,
  ConsoleStdout as ShimConsoleStdout,
  PreopenDirectory as ShimPreopenDirectory,
} from '@bjorn3/browser_wasi_shim';

// ---------------------------------------------------------------------------
// Error factories — message text mirrors Node v24.20.0 lib/internal/errors.js
// ---------------------------------------------------------------------------

const kTypes = [
  'string',
  'function',
  'number',
  'object',
  // Accept 'Function' and 'Object' as alternative to the lower cased version.
  'Function',
  'Object',
  'boolean',
  'bigint',
  'symbol',
];
const classRegExp = /^[A-Z][a-zA-Z0-9_$]*$/;

/** Minimal stand-in for util.inspect in error messages. */
function inspectValue(value, maxLength = 128) {
  let str;
  if (typeof value === 'string') {
    str = `'${value}'`;
  } else {
    try {
      str = JSON.stringify(value);
    } catch {
      str = undefined;
    }
    if (str === undefined) str = String(value);
  }
  if (str.length > maxLength) str = `${str.slice(0, maxLength)}...`;
  return str;
}

function formatList(array, type = 'and') {
  switch (array.length) {
    case 0: return '';
    case 1: return `${array[0]}`;
    case 2: return `${array[0]} ${type} ${array[1]}`;
    case 3: return `${array[0]}, ${array[1]}, ${type} ${array[2]}`;
    default:
      return `${array.slice(0, -1).join(', ')}, ${type} ${array[array.length - 1]}`;
  }
}

function determineSpecificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  switch (type) {
    case 'bigint':
      return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) {
        return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      } else if (value !== value) { // eslint-disable-line no-self-compare
        return `type number (NaN)`;
      } else if (value === Infinity) {
        return 'type number (Infinity)';
      } else if (value === -Infinity) {
        return 'type number (-Infinity)';
      }
      return `type number (${value})`;
    case 'boolean':
      return `type boolean (${value})`;
    case 'symbol':
      return `type symbol (${String(value)})`;
    case 'function':
      return `function ${value.name}`;
    case 'object': {
      let ctor;
      try {
        ctor = value.constructor;
      } catch {
        ctor = undefined;
      }
      if (ctor && 'name' in ctor) return `an instance of ${ctor.name}`;
      return inspectValue(value);
    }
    case 'string': {
      let v = value;
      if (v.length > 28) v = `${v.slice(0, 25)}...`;
      if (!v.includes("'")) return `type string ('${v}')`;
      return `type string (${JSON.stringify(v)})`;
    }
    default:
      return `type ${type} (${inspectValue(value, 28)})`;
  }
}

/**
 * Mirrors `ERR_INVALID_ARG_TYPE`: names containing '.' are "property",
 * everything else is "argument".
 */
function errInvalidArgType(name, expected, actual) {
  const expectedArray = Array.isArray(expected) ? expected : [expected];
  let msg = 'The ';
  if (name.endsWith(' argument')) {
    msg += `${name} `;
  } else {
    msg += `"${name}" ${name.includes('.') ? 'property' : 'argument'} `;
  }
  msg += 'must be ';

  const types = [];
  const instances = [];
  const other = [];
  for (const value of expectedArray) {
    if (kTypes.includes(value)) {
      types.push(value.toLowerCase());
    } else if (classRegExp.test(value)) {
      instances.push(value);
    } else {
      other.push(value);
    }
  }

  if (instances.length > 0) {
    const pos = types.indexOf('object');
    if (pos !== -1) {
      types.splice(pos, 1);
      instances.push('Object');
    }
  }

  if (types.length > 0) {
    msg += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
    if (instances.length > 0 || other.length > 0) msg += ' or ';
  }

  if (instances.length > 0) {
    msg += `an instance of ${formatList(instances, 'or')}`;
    if (other.length > 0) msg += ' or ';
  }

  if (other.length > 0) {
    if (other.length > 1) {
      msg += `one of ${formatList(other, 'or')}`;
    } else {
      if (other[0].toLowerCase() !== other[0]) msg += 'an ';
      msg += `${other[0]}`;
    }
  }

  msg += `. Received ${determineSpecificType(actual)}`;
  return Object.assign(new TypeError(msg), { code: 'ERR_INVALID_ARG_TYPE' });
}

/** Mirrors `ERR_INVALID_ARG_VALUE` (a TypeError in Node). */
function errInvalidArgValue(name, value, reason = 'is invalid') {
  const kind = name.includes('.') ? 'property' : 'argument';
  const msg = `The ${kind} '${name}' ${reason}. Received ${inspectValue(value)}`;
  return Object.assign(new TypeError(msg), { code: 'ERR_INVALID_ARG_VALUE' });
}

/** Mirrors `ERR_OUT_OF_RANGE` (a RangeError in Node). */
function errOutOfRange(name, range, input) {
  const received = inspectValue(input, Infinity);
  const msg = `The value of "${name}" is out of range. It must be ${range}. Received ${received}`;
  return Object.assign(new RangeError(msg), { code: 'ERR_OUT_OF_RANGE' });
}

function errWasiAlreadyStarted() {
  return Object.assign(
    new Error('WASI instance has already started'),
    { code: 'ERR_WASI_ALREADY_STARTED' },
  );
}

/** Raised for proc_exit when returnOnExit is false (no process to exit). */
function errWasiExit(code) {
  return Object.assign(
    new Error(`WASI proc_exit called with code ${code} (no process to exit in this environment)`),
    { code: 'WASI_EXIT', exitCode: code },
  );
}

// ---------------------------------------------------------------------------
// Validators — mirrors Node v24.20.0 lib/internal/validators.js
// ---------------------------------------------------------------------------

/** @param {unknown} v @param {string} name */
function validateObject(v, name) {
  if (v === null || Array.isArray(v) || typeof v !== 'object')
    throw errInvalidArgType(name, 'Object', v);
}

/** @param {unknown} v @param {string} name */
function validateString(v, name) {
  if (typeof v !== 'string')
    throw errInvalidArgType(name, 'string', v);
}

/** @param {unknown} v @param {string} name */
function validateArray(v, name) {
  if (!Array.isArray(v))
    throw errInvalidArgType(name, 'Array', v);
}

/** @param {unknown} v @param {string} name */
function validateBoolean(v, name) {
  if (typeof v !== 'boolean')
    throw errInvalidArgType(name, 'boolean', v);
}

/** @param {unknown} v @param {string} name */
function validateFunction(v, name) {
  if (typeof v !== 'function')
    throw errInvalidArgType(name, 'Function', v);
}

/** @param {unknown} v @param {string} name */
function validateUndefined(v, name) {
  if (v !== undefined)
    throw errInvalidArgType(name, 'undefined', v);
}

/** @param {unknown} v @param {string} name @param {number} [min] @param {number} [max] */
function validateInt32(v, name, min = -2147483648, max = 2147483647) {
  if (typeof v !== 'number')
    throw errInvalidArgType(name, 'number', v);
  if (!Number.isInteger(v))
    throw errOutOfRange(name, 'an integer', v);
  if (v < min || v > max)
    throw errOutOfRange(name, `>= ${min} && <= ${max}`, v);
}

/**
 * Brand check for WebAssembly.Memory that works across VM contexts, mirroring
 * the C++ `IsWasmMemoryObject()` check Node performs in `_setMemory`.
 * (`instanceof WebAssembly.Memory` is false for cross-realm memories, and
 * calling `Memory.prototype.grow` would detach the current buffer as a side
 * effect, so neither is usable here.)
 * @param {unknown} v
 */
function isWasmMemoryObject(v) {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function'))
    return false;
  return Object.prototype.toString.call(v) === '[object WebAssembly.Memory]';
}

// ---------------------------------------------------------------------------
// WASI preview1 ABI constants
// ---------------------------------------------------------------------------

const ERRNO_SUCCESS = 0; // __WASI_ERRNO_SUCCESS
const ERRNO_BADF = 8;    // __WASI_ERRNO_BADF
const ERRNO_INVAL = 28;  // __WASI_ERRNO_INVAL
const ERRNO_NOSYS = 52;  // __WASI_ERRNO_NOSYS — "function not implemented"

const CLOCKID_REALTIME = 0;
const CLOCKID_MONOTONIC = 1;

// ---------------------------------------------------------------------------
// Private slots — mirror Node's internal symbol pattern
// ---------------------------------------------------------------------------

const kArgs = Symbol('kArgs');
const kEnv = Symbol('kEnv');
const kPreopens = Symbol('kPreopens');
const kStdio = Symbol('kStdio');
const kReturnOnExit = Symbol('kReturnOnExit');
const kStarted = Symbol('kStarted');
const kBound = Symbol('kBound');
const kInstance = Symbol('kInstance');
const kMemory = Symbol('kMemory');
const kBindingName = Symbol('kBindingName');
const kShim = Symbol('kShim');

// ---------------------------------------------------------------------------
// WASI class
// ---------------------------------------------------------------------------

/**
 * Browser-compatible WASI runtime host. Validation behaviour matches
 * Node.js v24.20.0's `lib/wasi.js`; the syscall engine is the maintained
 * `@bjorn3/browser_wasi_shim` preview1 implementation (see module docs for
 * the normalisation layer on top of it).
 *
 * @example
 * import { WASI } from './wasi.js';
 *
 * const wasi = new WASI({
 *   version: 'preview1',
 *   args: ['app.wasm'],
 *   preopens: { '/sandbox': '/ignored-in-browser' },
 * });
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

    // ── version (required, no default) ────────────────────────────────────
    validateString(options.version, 'options.version');
    switch (options.version) {
      case 'unstable': this[kBindingName] = 'wasi_unstable';          break;
      case 'preview1': this[kBindingName] = 'wasi_snapshot_preview1'; break;
      default:
        throw errInvalidArgValue('options.version', options.version,
                                 'unsupported WASI version');
    }

    // ── args ──────────────────────────────────────────────────────────────
    if (options.args !== undefined) validateArray(options.args, 'options.args');
    this[kArgs] = (options.args || []).map(String);

    // ── env — serialised as KEY=VALUE strings, like Node ──────────────────
    this[kEnv] = [];
    if (options.env !== undefined) {
      validateObject(options.env, 'options.env');
      for (const [key, value] of Object.entries(options.env)) {
        if (value !== undefined) this[kEnv].push(`${key}=${value}`);
      }
    }

    // ── preopens — virtual in-memory directories in a browser ─────────────
    // (no host filesystem; the mapped host path is kept as a label only).
    this[kPreopens] = [];
    if (options.preopens !== undefined) {
      validateObject(options.preopens, 'options.preopens');
      for (const [key, value] of Object.entries(options.preopens)) {
        this[kPreopens].push([String(key), String(value)]);
      }
    }

    // ── stdio fd numbers — validated like Node ────────────────────────────
    const { stdin = 0, stdout = 1, stderr = 2 } = options;
    validateInt32(stdin, 'options.stdin', 0);
    validateInt32(stdout, 'options.stdout', 0);
    validateInt32(stderr, 'options.stderr', 0);
    this[kStdio] = [stdin, stdout, stderr];

    // ── returnOnExit ──────────────────────────────────────────────────────
    let returnOnExit = true;
    if (options.returnOnExit !== undefined) {
      validateBoolean(options.returnOnExit, 'options.returnOnExit');
      returnOnExit = options.returnOnExit;
    }
    this[kReturnOnExit] = returnOnExit;

    // ── Engine: stdio + preopens wired into the shim's fd table ───────────
    // The shim indexes fds by guest fd number. stdin is an empty readable
    // file (reads → EOF); stdout/stderr stream complete lines to the
    // console; each preopen becomes a real virtual PreopenDirectory.
    const self = this;
    const fds = [];
    const [stdinFd, stdoutFd, stderrFd] = this[kStdio];
    fds[stdinFd] = new ShimOpenFile(new ShimFile([]));
    fds[stdoutFd] = ShimConsoleStdout.lineBuffered((msg) => console.log(msg));
    fds[stderrFd] = ShimConsoleStdout.lineBuffered((msg) => console.error(msg));
    let nextFd = 3;
    for (const [guestPath] of this[kPreopens]) {
      while (fds[nextFd] !== undefined) nextFd++;
      fds[nextFd] = new ShimPreopenDirectory(guestPath, []);
      nextFd++;
    }

    // The shim enables its debug logger when options.debug is undefined;
    // pass false explicitly — path_open etc. must not spam the console.
    const shim = new ShimWASI(this[kArgs], this[kEnv], fds, { debug: false });
    this[kShim] = shim;
    this[kBound] = false;

    // ── Normalisation layer over the shim's wasiImport ────────────────────
    // (see module docs for the rationale of each rule).
    const rawImport = shim.wasiImport;
    const rawProcExit = rawImport.proc_exit;
    const wasiImport = {};
    for (const name of Object.keys(rawImport)) {
      const fn = rawImport[name];
      if (name === 'proc_exit') {
        wasiImport[name] = (code) => {
          if (!self[kReturnOnExit]) throw errWasiExit(code);
          // Throws the shim's WASIProcExit; start() converts it to a code.
          return fn(code);
        };
      } else if (name === 'proc_raise' || name.startsWith('sock_')) {
        // Sockets and signals are unavailable: errno, never a throw.
        wasiImport[name] = () => ERRNO_NOSYS;
      } else if (name === 'sched_yield') {
        wasiImport[name] = () => {
          fn();
          return ERRNO_SUCCESS;
        };
      } else if (name === 'clock_time_get' || name === 'clock_res_get') {
        wasiImport[name] = (clockid, ...rest) => {
          if (!self[kBound]) return ERRNO_NOSYS;
          if (clockid !== CLOCKID_REALTIME && clockid !== CLOCKID_MONOTONIC)
            return ERRNO_INVAL;
          return fn(clockid, ...rest) ?? ERRNO_SUCCESS;
        };
      } else if (name === 'fd_write') {
        wasiImport[name] = (fd, ...rest) => {
          if (!self[kBound]) return ERRNO_NOSYS;
          if (fd === self[kStdio][0]) return ERRNO_BADF; // stdin is read-only
          return fn(fd, ...rest);
        };
      } else if (name === 'fd_read') {
        wasiImport[name] = (fd, ...rest) => {
          if (!self[kBound]) return ERRNO_NOSYS;
          // stdout/stderr are write-only
          if (fd === self[kStdio][1] || fd === self[kStdio][2]) return ERRNO_BADF;
          return fn(fd, ...rest);
        };
      } else {
        wasiImport[name] = (...args) => {
          if (!self[kBound]) return ERRNO_NOSYS;
          return fn(...args) ?? ERRNO_SUCCESS;
        };
      }
    }
    this.wasiImport = wasiImport;

    this[kStarted] = false;
    this[kInstance] = undefined;
    this[kMemory] = undefined;
  }

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

    validateObject(instance, 'instance');
    validateObject(instance.exports, 'instance.exports');

    // Mirrors the C++ _setMemory brand check (works across VM contexts).
    if (!isWasmMemoryObject(memory)) {
      throw Object.assign(
        new TypeError('"instance.exports.memory" property must be a WebAssembly.Memory object'),
        { code: 'ERR_INVALID_ARG_TYPE' },
      );
    }

    // Point the engine at this instance without invoking an entry point.
    // The shim resolves guest memory through its own instance reference
    // at call time, so this is all the binding it needs.
    this[kShim].inst = instance;
    this[kBound] = true;
    this[kMemory] = memory;
    this[kInstance] = instance;
    this[kStarted] = true;
  }

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
    validateFunction(_start, 'instance.exports._start');
    validateUndefined(_initialize, 'instance.exports._initialize');

    // The shim invokes _start and converts the guest's WASIProcExit into
    // the exit code. Our proc_exit wrapper already honoured returnOnExit.
    return this[kShim].start(instance);
  }

  /**
   * Initialises a WASI *reactor* module. The instance must NOT export
   * `_start`; it may optionally export `_initialize`.
   *
   * @param {WebAssembly.Instance} instance
   */
  initialize(instance) {
    this.finalizeBindings(instance);

    const { _start, _initialize } = this[kInstance].exports;
    validateUndefined(_start, 'instance.exports._start');

    if (_initialize !== undefined) {
      validateFunction(_initialize, 'instance.exports._initialize');
    }
    this[kShim].initialize(instance);
  }

  /**
   * Returns an import object ready for `WebAssembly.instantiate()`.
   * Key is `wasi_snapshot_preview1` for preview1 or `wasi_unstable` for
   * unstable (the syscall sets are identical; only the module name
   * differs, as in Node).
   *
   * @returns {{ wasi_snapshot_preview1: object } | { wasi_unstable: object }}
   */
  getImportObject() {
    return { [this[kBindingName]]: this.wasiImport };
  }
}

// Mirror Node's CJS shape: require('wasi') === { WASI }.
export default { WASI };
