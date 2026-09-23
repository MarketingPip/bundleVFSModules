/**
 * @packageDocumentation
 * Implements `node:wasi` for browser and bundler environments.
 *
 * Dependency-free ESM port of Node.js v24.20.0's `lib/wasi.js` facade, backed
 * by a small pure-JS WASI preview1/unusable host instead of Node's native
 * uvwasi binding:
 *
 *   - Constructor options (`version`, `args`, `env`, `preopens`,
 *     `returnOnExit`, `stdin`, `stdout`, `stderr`) are validated exactly the
 *     way Node does, including the `ERR_*` codes and message text.
 *   - `wasi.getImportObject()` — ready for `WebAssembly.instantiate()`.
 *   - `wasi.start(instance)`  — WASI command entry (`_start`).
 *   - `wasi.initialize(instance)` — WASI reactor entry (`_initialize`).
 *   - `wasi.finalizeBindings(instance, options?)` — bind without entry call.
 *   - `wasi.wasiImport` — the preview1 syscall object for manual
 *     instantiation.
 *
 * Honestly implemented syscalls (pure JS, real behaviour): `args_get`,
 * `args_sizes_get`, `environ_get`, `environ_sizes_get`, `proc_exit`,
 * `fd_write` (fds 1/2 → console), `fd_read` (fd 0 → EOF),
 * `clock_time_get` (realtime/monotonic), `clock_res_get`, `random_get`
 * (via `crypto.getRandomValues`), `sched_yield`.
 *
 * Everything else in the preview1 ABI (filesystem, sockets, `poll_oneoff`,
 * `proc_raise`, …) returns `__WASI_ERRNO_NOSYS` (52) — an honest
 * "not implemented" errno for the guest, never a fabricated success and
 * never a throw.
 *
 * Known gaps vs Node (documented, not faked):
 *   - `preopens` values are kept as virtual mount names; there is no host
 *     filesystem in a browser, so Node's `UVWASI_ENOENT` validation of the
 *     host path cannot be reproduced.
 *   - `stdin`/`stdout`/`stderr` fd numbers are accepted and validated but
 *     the stdio streams are virtual: stdin reads EOF, stdout/stderr go to
 *     the console.
 *   - `returnOnExit: false` cannot `process.exit()` in a browser; the
 *     guest's `proc_exit` surfaces as an `Error` with code `'WASI_EXIT'`
 *     instead of terminating anything.
 */

/* globalThis._RUNTIME_ is intentionally not used: this module needs no host
 * runtime services (no fs, no sockets, no process config). Everything it
 * touches — WebAssembly, TextEncoder/Decoder, crypto, performance, console —
 * is a plain global available in browsers and in Node. */

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
        return 'type number (NaN)';
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

// Every function in the wasi_snapshot_preview1 / wasi_unstable ABI.
// The two versions share the same syscall set; only the import-module name
// differs.
const SYSCALL_NAMES = [
  'args_get', 'args_sizes_get', 'environ_get', 'environ_sizes_get',
  'clock_res_get', 'clock_time_get',
  'fd_advise', 'fd_allocate', 'fd_close', 'fd_datasync',
  'fd_fdstat_get', 'fd_fdstat_set_flags', 'fd_fdstat_set_rights',
  'fd_filestat_get', 'fd_filestat_set_size', 'fd_filestat_set_times',
  'fd_pread', 'fd_prestat_get', 'fd_prestat_dir_name', 'fd_pwrite',
  'fd_read', 'fd_readdir', 'fd_renumber', 'fd_seek', 'fd_sync',
  'fd_tell', 'fd_write',
  'path_create_directory', 'path_filestat_get', 'path_filestat_set_times',
  'path_link', 'path_open', 'path_readlink', 'path_remove_directory',
  'path_rename', 'path_symlink', 'path_unlink_file',
  'poll_oneoff', 'proc_exit', 'proc_raise', 'sched_yield',
  'random_get',
  'sock_accept', 'sock_recv', 'sock_send', 'sock_shutdown',
];

// ---------------------------------------------------------------------------
// Private slots — mirror Node's internal symbol pattern
// ---------------------------------------------------------------------------

const kArgs = Symbol('kArgs');
const kEnv = Symbol('kEnv');
const kPreopens = Symbol('kPreopens');
const kStdio = Symbol('kStdio');
const kReturnOnExit = Symbol('kReturnOnExit');
// Like Node, one symbol doubles as the exit-code slot and the sentinel
// thrown by proc_exit (WebAssembly cannot catch a JS symbol, so it unwinds
// the whole wasm stack back to start()).
const kExit = Symbol('kExit');
const kStarted = Symbol('kStarted');
const kInstance = Symbol('kInstance');
const kMemory = Symbol('kMemory');
const kBindingName = Symbol('kBindingName');
const kStdoutBuf = Symbol('kStdoutBuf');
const kStderrBuf = Symbol('kStderrBuf');

/** @param {WASI} self */
function memoryView(self) {
  const mem = self[kMemory];
  if (!isWasmMemoryObject(mem)) return null;
  return new DataView(mem.buffer);
}

/** @param {WASI} self @param {number} fd @param {string} text */
function writeConsole(self, fd, text) {
  const key = fd === 1 ? kStdoutBuf : kStderrBuf;
  const emit = fd === 1 ? console.log : console.error;
  let buf = self[key] + text;
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    emit(buf.slice(0, idx).replace(/\r$/, ''));
    buf = buf.slice(idx + 1);
  }
  self[key] = buf;
}

/** Flush any partial console line. @param {WASI} self */
function flushConsole(self) {
  if (self[kStdoutBuf] !== '') {
    console.log(self[kStdoutBuf]);
    self[kStdoutBuf] = '';
  }
  if (self[kStderrBuf] !== '') {
    console.error(self[kStderrBuf]);
    self[kStderrBuf] = '';
  }
}

/**
 * @param {WASI} self
 * @param {string[]} strings
 * @param {number} countPtr
 * @param {number} bufSizePtr
 */
function sizesGet(self, strings, countPtr, bufSizePtr) {
  const view = memoryView(self);
  if (!view) return ERRNO_NOSYS;
  const enc = new TextEncoder();
  let bufSize = 0;
  for (const s of strings) bufSize += enc.encode(s).length + 1;
  view.setUint32(countPtr >>> 0, strings.length, true);
  view.setUint32(bufSizePtr >>> 0, bufSize, true);
  return ERRNO_SUCCESS;
}

/**
 * @param {WASI} self
 * @param {string[]} strings
 * @param {number} ptr
 * @param {number} bufPtr
 */
function stringsGet(self, strings, ptr, bufPtr) {
  const view = memoryView(self);
  if (!view) return ERRNO_NOSYS;
  const enc = new TextEncoder();
  const bytes = new Uint8Array(view.buffer);
  let offset = bufPtr >>> 0;
  strings.forEach((s, i) => {
    const encoded = enc.encode(s);
    view.setUint32((ptr >>> 0) + i * 4, offset, true);
    bytes.set(encoded, offset);
    bytes[offset + encoded.length] = 0;
    offset += encoded.length + 1;
  });
  return ERRNO_SUCCESS;
}

// ---------------------------------------------------------------------------
// WASI class
// ---------------------------------------------------------------------------

/**
 * Browser-compatible WASI runtime host. Validation behaviour matches
 * Node.js v24.20.0's `lib/wasi.js`; the syscall layer is an honest
 * pure-JS subset (see module docs).
 *
 * @example
 * import { WASI } from './wasi.js';
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

    // ── preopens — virtual mount names in a browser (no host fs) ──────────
    this[kPreopens] = [];
    if (options.preopens !== undefined) {
      validateObject(options.preopens, 'options.preopens');
      for (const [key, value] of Object.entries(options.preopens)) {
        this[kPreopens].push([String(key), String(value)]);
      }
    }

    // ── stdio fd numbers — validated like Node; the streams themselves ────
    // are virtual (see module docs).
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

    // ── Build wasiImport ──────────────────────────────────────────────────
    const self = this;
    const implemented = {
      args_sizes_get: (argcPtr, argvBufSizePtr) =>
        sizesGet(self, self[kArgs], argcPtr, argvBufSizePtr),
      args_get: (argvPtr, argvBufPtr) =>
        stringsGet(self, self[kArgs], argvPtr, argvBufPtr),
      environ_sizes_get: (environcPtr, environBufSizePtr) =>
        sizesGet(self, self[kEnv], environcPtr, environBufSizePtr),
      environ_get: (environPtr, environBufPtr) =>
        stringsGet(self, self[kEnv], environPtr, environBufPtr),

      clock_res_get: (clockid, resPtr) => {
        const view = memoryView(self);
        if (!view) return ERRNO_NOSYS;
        if (clockid !== CLOCKID_REALTIME && clockid !== CLOCKID_MONOTONIC)
          return ERRNO_INVAL;
        // Date.now() resolves to ~1ms, performance.now() to ~1µs here.
        view.setBigUint64(resPtr >>> 0, clockid === CLOCKID_REALTIME ? 1000000n : 1000n, true);
        return ERRNO_SUCCESS;
      },
      clock_time_get: (clockid, _precision, timePtr) => {
        const view = memoryView(self);
        if (!view) return ERRNO_NOSYS;
        let nanos;
        if (clockid === CLOCKID_REALTIME) {
          nanos = BigInt(Date.now()) * 1000000n;
        } else if (clockid === CLOCKID_MONOTONIC &&
                   typeof performance !== 'undefined' &&
                   typeof performance.now === 'function') {
          nanos = BigInt(Math.floor(performance.now() * 1e6));
        } else {
          return ERRNO_INVAL;
        }
        view.setBigUint64(timePtr >>> 0, nanos, true);
        return ERRNO_SUCCESS;
      },

      // fd 0 is an empty readable stream: immediate EOF.
      fd_read: (fd, _iovsPtr, _iovsLen, nreadPtr) => {
        if (fd !== 0) return ERRNO_BADF;
        const view = memoryView(self);
        if (!view) return ERRNO_NOSYS;
        view.setUint32(nreadPtr >>> 0, 0, true);
        return ERRNO_SUCCESS;
      },
      // fds 1/2 go to the console; anything else is a bad fd here.
      fd_write: (fd, iovsPtr, iovsLen, nwrittenPtr) => {
        if (fd !== 1 && fd !== 2) return ERRNO_BADF;
        const view = memoryView(self);
        if (!view) return ERRNO_NOSYS;
        const bytes = new Uint8Array(view.buffer);
        const decoder = new TextDecoder();
        let text = '';
        let total = 0;
        for (let i = 0; i < (iovsLen >>> 0); i++) {
          const base = (iovsPtr >>> 0) + i * 8;
          const ptr = view.getUint32(base, true) >>> 0;
          const len = view.getUint32(base + 4, true) >>> 0;
          text += decoder.decode(bytes.subarray(ptr, ptr + len), { stream: true });
          total += len;
        }
        text += decoder.decode();
        writeConsole(self, fd, text);
        view.setUint32(nwrittenPtr >>> 0, total, true);
        return ERRNO_SUCCESS;
      },

      random_get: (bufPtr, bufLen) => {
        const view = memoryView(self);
        if (!view) return ERRNO_NOSYS;
        const gCrypto = typeof globalThis.crypto !== 'undefined'
          ? globalThis.crypto
          : undefined;
        if (!gCrypto || typeof gCrypto.getRandomValues !== 'function')
          return ERRNO_NOSYS;
        const len = bufLen >>> 0;
        const tmp = new Uint8Array(len);
        gCrypto.getRandomValues(tmp);
        new Uint8Array(view.buffer).set(tmp, bufPtr >>> 0);
        return ERRNO_SUCCESS;
      },

      sched_yield: () => ERRNO_SUCCESS,

      proc_exit: (rval) => {
        flushConsole(self);
        if (self[kReturnOnExit]) {
          // Record the exit code and unwind the whole wasm stack: like Node,
          // throw a symbol WebAssembly cannot catch.
          self[kExit] = rval;
          throw kExit;
        }
        // No process.exit() in a browser — surface it instead of pretending
        // the guest exited cleanly.
        throw Object.assign(
          new Error(`WASI proc_exit called with code ${rval} (no process to exit in this environment)`),
          { code: 'WASI_EXIT', exitCode: rval },
        );
      },
    };

    const wasiImport = {};
    for (const name of SYSCALL_NAMES) {
      wasiImport[name] = implemented[name] ?? (() => ERRNO_NOSYS);
    }
    this.wasiImport = wasiImport;

    this[kStarted] = false;
    this[kExit] = 0;
    this[kInstance] = undefined;
    this[kMemory] = undefined;
    this[kStdoutBuf] = '';
    this[kStderrBuf] = '';
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

    try {
      _start();
    } catch (err) {
      if (err !== kExit) throw err;
    }
    flushConsole(this);

    return this[kExit];
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
      _initialize();
    }
  }

  /**
   * Returns an import object ready for `WebAssembly.instantiate()`.
   * Key is `wasi_snapshot_preview1` for preview1 or `wasi_unstable` for
   * unstable.
   *
   * @returns {{ wasi_snapshot_preview1: object } | { wasi_unstable: object }}
   */
  getImportObject() {
    return { [this[kBindingName]]: this.wasiImport };
  }
}

// Mirror Node's CJS shape: require('wasi') === { WASI }.
export default { WASI };
