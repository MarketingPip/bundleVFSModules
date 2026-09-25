/**
 * Browser-compatible child_process shim — port of Node v24.20.0 lib/child_process.js
 *
 * Argument validation, error codes/messages, option normalization, return
 * shapes, and event names match Node v24.20.0. Real subprocesses are
 * impossible in a browser, so execution degrades gracefully:
 *
 * ─── Host postMessage protocol (RUNTIME INTEGRATION — do not change) ────────
 * Async spawn/exec/execFile delegate to the parent frame:
 *
 *   parent.postMessage({ type, requestId, payload }, '*')
 *
 *   type:    'PARENT_EXEC_REQUEST' | 'PARENT_SPAWN_REQUEST'
 *   requestId: `cp_${Date.now()}_${n}` (unique per call)
 *   PARENT_EXEC_REQUEST  payload: { command: string, options }
 *   PARENT_SPAWN_REQUEST payload: { command: string, args: string[], options }
 *
 * The shim listens for window 'message' events and accepts the response whose
 *   data = { type: 'PARENT_CHILD_EXEC_RESPONSE', requestId, payload }
 * matches the request. `payload` is `{ stdout, stderr, exitCode, signal }`.
 *
 * Timeout (options.timeout ms) rejects the request with ETIMEDOUT
 * ('Process timed out'); aborting the child's AbortController rejects with
 * 'Process killed' (code SIGTERM, killed: true). Without a `window`, or
 * without a parent frame that implements postMessage, the request rejects
 * (ERR_NO_WINDOW / ERR_NO_PARENT) and the child emits 'error' and finalizes
 * with exit code 1 — honest degradation, never a synchronous throw.
 *
 * ─── What works where ───────────────────────────────────────────────────────
 * - Jared's runtime (iframe inside the CodeSandbox host): the host parent
 *   frame implements the protocol, so spawn/exec/execFile really run and
 *   stream stdout/stderr/exitCode back through PARENT_CHILD_EXEC_RESPONSE.
 * - Standalone browser (no implementing parent): validation, shapes, events,
 *   kill/timeout/abort semantics all work; execution requests fail closed
 *   with ERR_NO_PARENT and the child finalizes with code 1.
 * - Sync APIs (execSync/spawnSync/execFileSync) and fork(): a real
 *   subprocess can never exist here. They validate arguments exactly like
 *   Node, then return honest noops: fork() returns a live-but-idle
 *   ChildProcess with a closed IPC channel; the *Sync functions return
 *   empty success-shaped results.
 *
 * Lifecycle invariants (preserved from the original shim):
 * - A child can only be finalized once.
 * - stdout/stderr are ended exactly once.
 * - kill() and parent responses cannot finalize the same child twice.
 * - Output arriving after finalization is ignored.
 */

import { EventEmitter } from './events.js';
import { Readable, Writable } from './stream.js';

// ─── Validation (message shapes ported from Node's internal/errors.js) ──────

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

const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;

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

/**
 * Minimal util.inspect for error messages: single-quoted strings with
 * control characters escaped the way Node renders them.
 */
function inspectValue(value) {
  if (typeof value === 'string') {
    const escaped = value.replace(/[\0-\x1f\x7f'\\]/g, (ch) => {
      switch (ch) {
        case '\0': return '\\x00';
        case '\n': return '\\n';
        case '\r': return '\\r';
        case '\t': return '\\t';
        case '\'': return '\\\'';
        case '\\': return '\\\\';
        default: {
          const code = ch.charCodeAt(0).toString(16).padStart(2, '0');
          return `\\x${code}`;
        }
      }
    });
    const short = escaped.length > 128 ? `${escaped.slice(0, 128)}...` : escaped;
    return `'${short}'`;
  }
  if (typeof value === 'number' || typeof value === 'boolean' ||
      typeof value === 'bigint' || value === null || value === undefined) {
    return String(value);
  }
  // Node's util.inspect renders Buffers as `<Buffer 61 00 62>`.
  const Buf = globalThis.Buffer;
  if (Buf && value instanceof Buf) {
    const hex = Array.from(value, (b) => b.toString(16).padStart(2, '0')).join(' ');
    return `<Buffer ${hex.length > 120 ? `${hex.slice(0, 120)}...` : hex}>`;
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value) &&
      !(value instanceof DataView)) {
    const name = value.constructor ? value.constructor.name : 'TypedArray';
    return `${name}(${value.length}) [ ${Array.from(value).join(', ')} ]`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function determineSpecificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  switch (type) {
    case 'bigint': return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      if (value !== value) return 'type number (NaN)';
      if (value === Infinity) return 'type number (Infinity)';
      if (value === -Infinity) return 'type number (-Infinity)';
      return `type number (${value})`;
    case 'boolean': return value ? 'type boolean (true)' : 'type boolean (false)';
    case 'symbol': return `type symbol (${String(value)})`;
    case 'function': return `function ${value.name}`;
    case 'object':
      if (value.constructor && 'name' in value.constructor) {
        return `an instance of ${value.constructor.name}`;
      }
      return `${inspectValue(value)}`;
    case 'string': {
      let v = value;
      if (v.length > 28) v = `${v.slice(0, 25)}...`;
      if (!v.includes("'")) return `type string ('${v}')`;
      return `type string (${JSON.stringify(v)})`;
    }
    default: return `${type}`;
  }
}

function errInvalidArgType(name, expected, actual) {
  if (!Array.isArray(expected)) expected = [expected];
  let msg = 'The ';
  const type = name.includes('.') ? 'property' : 'argument';
  msg += `"${name}" ${type} must be `;

  const types = [];
  const instances = [];
  const other = [];

  for (const value of expected) {
    if (kTypes.includes(value)) {
      types.push(value.toLowerCase());
    } else if (classRegExp.test(value)) {
      instances.push(value);
    } else {
      other.push(value);
    }
  }

  // Special handle `object` in case other instances are allowed to outline
  // the differences between each other.
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

function errInvalidArgValue(name, value, reason = 'is invalid') {
  const type = name.includes('.') ? 'property' : 'argument';
  const msg = `The ${type} '${name}' ${reason}. Received ${inspectValue(value)}`;
  return Object.assign(new TypeError(msg), { code: 'ERR_INVALID_ARG_VALUE' });
}

function errOutOfRange(name, range, value) {
  const msg = `The value of "${name}" is out of range. It must be ${range}. Received ${inspectValue(value)}`;
  return Object.assign(new RangeError(msg), { code: 'ERR_OUT_OF_RANGE' });
}

function errUnknownSignal(signal) {
  const msg = `Unknown signal: ${String(signal)}`;
  return Object.assign(new TypeError(msg), { code: 'ERR_UNKNOWN_SIGNAL' });
}

function errStdioMaxBuffer(which) {
  const msg = `${which} maxBuffer length exceeded`;
  return Object.assign(new Error(msg), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
}

function validateString(value, name) {
  if (typeof value !== 'string') throw errInvalidArgType(name, 'string', value);
}

function validateFunction(value, name) {
  if (typeof value !== 'function') throw errInvalidArgType(name, 'Function', value);
}

function validateObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw errInvalidArgType(name, 'Object', value);
  }
}

function validateArray(value, name) {
  if (!Array.isArray(value)) throw errInvalidArgType(name, 'Array', value);
}

function validateBoolean(value, name) {
  if (typeof value !== 'boolean') throw errInvalidArgType(name, 'boolean', value);
}

function validateAbortSignal(signal, name) {
  if (signal !== undefined &&
      (signal === null || typeof signal !== 'object' || !('aborted' in signal))) {
    throw errInvalidArgType(name, 'AbortSignal', signal);
  }
}

/**
 * Node's validateArgumentNullCheck: only strings are inspected, anything
 * else passes through untouched.
 */
function validateStringNullBytes(value, name) {
  if (typeof value === 'string' && value.includes('\0')) {
    throw errInvalidArgValue(name, value, 'must be a string without null bytes');
  }
}

function isInt32(value) {
  return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
}

function validateTimeout(timeout) {
  if (timeout != null && !(Number.isInteger(timeout) && timeout >= 0)) {
    throw errOutOfRange('timeout', 'an unsigned integer', timeout);
  }
}

function validateMaxBuffer(maxBuffer) {
  if (maxBuffer != null && !(typeof maxBuffer === 'number' && maxBuffer >= 0)) {
    throw errOutOfRange('options.maxBuffer', 'a positive number', maxBuffer);
  }
}

/**
 * Accepts a string path, Buffer/Uint8Array, or file: URL — like Node's
 * getValidatedPath (internal/fs/utils.js). Null-byte rejection uses Node's
 * exact reason phrase; a non-file: URL throws ERR_INVALID_URL_SCHEME.
 */
function getValidatedPath(p, prop) {
  if (typeof p === 'string') {
    if (p.includes('\0')) {
      throw errInvalidArgValue(
        prop, p, 'must be a string, Uint8Array, or URL without null bytes');
    }
    return p;
  }
  if (typeof URL !== 'undefined' && p instanceof URL) {
    if (p.protocol !== 'file:') {
      const err = new TypeError('The URL must be of scheme file');
      err.code = 'ERR_INVALID_URL_SCHEME';
      throw err;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(p.pathname);
    } catch {
      decoded = p.pathname;
    }
    // Node validates the decoded path for null bytes.
    if (decoded.includes('\0')) {
      throw errInvalidArgValue(
        prop, decoded, 'must be a string, Uint8Array, or URL without null bytes');
    }
    return decoded;
  }
  const Buf = globalThis.Buffer;
  const isBytes = (Buf && p instanceof Buf) ||
    (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(p));
  if (isBytes) {
    const bytes = Buf && p instanceof Buf ? Uint8Array.from(p) : p;
    // Node's validatePath rejects raw zero bytes in Uint8Arrays too.
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) {
        throw errInvalidArgValue(
          prop, p, 'must be a string, Uint8Array, or URL without null bytes');
      }
    }
    return new TextDecoder().decode(bytes);
  }
  throw errInvalidArgType(prop, ['string', 'Buffer', 'URL'], p);
}

// ─── Signals (port of Node's convertToValidSignal) ──────────────────────────

const SIGNALS = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5,
  SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10,
  SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
  SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20,
  SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25,
  SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPWR: 30,
  SIGSYS: 31,
};
const SIGNAL_NUMBERS = new Set(Object.values(SIGNALS));
const SIGNAL_NAMES = {};
for (const [name, num] of Object.entries(SIGNALS)) SIGNAL_NAMES[num] = name;

function convertToValidSignal(signal) {
  if (typeof signal === 'number' && SIGNAL_NUMBERS.has(signal)) return signal;
  if (typeof signal === 'string') {
    const num = SIGNALS[signal.toUpperCase()];
    if (num !== undefined) return num;
  }
  throw errUnknownSignal(signal);
}

function sanitizeKillSignal(killSignal) {
  if (typeof killSignal === 'string' || typeof killSignal === 'number') {
    return convertToValidSignal(killSignal);
  } else if (killSignal != null) {
    throw errInvalidArgType('options.killSignal', ['string', 'number'], killSignal);
  }
  return undefined;
}

function signalNameOf(sig) {
  if (typeof sig === 'number') return SIGNAL_NAMES[sig] ?? String(sig);
  return sig;
}

class AbortError extends Error {
  constructor(cause) {
    super('This operation was aborted');
    this.name = 'AbortError';
    this.code = 'ABORT_ERR';
    if (cause !== undefined) this.cause = cause;
  }
}

// ─── Encoding ───────────────────────────────────────────────────────────────

const MAX_BUFFER = 1024 * 1024;

const VALID_ENCODINGS = new Set([
  'utf8', 'utf-8', 'ascii', 'latin1', 'binary', 'base64', 'base64url',
  'hex', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le',
]);

/**
 * Like Node's execFile encoding resolution: 'buffer'/null/invalid →
 * Buffer output, otherwise the named string encoding.
 */
function resolveEncoding(encoding) {
  if (encoding !== 'buffer' && typeof encoding === 'string' &&
      VALID_ENCODINGS.has(encoding.toLowerCase())) {
    return encoding;
  }
  return null;
}

function toOutput(text, encoding) {
  if (encoding) return text;
  const Buf = globalThis.Buffer;
  if (Buf && typeof Buf.from === 'function') return Buf.from(text, 'utf8');
  return new TextEncoder().encode(text);
}

// ─── Runtime helpers ────────────────────────────────────────────────────────

let _reqCounter = 0;

function makeRequestId() {
  return `cp_${Date.now()}_${++_reqCounter}`;
}

function makeFakePid() {
  return Math.floor(Math.random() * 32768) + 1024;
}

const DEFAULT_TIMEOUT = 0;

function getRuntime() {
  return globalThis._RUNTIME_ || null;
}

function getTaskTracker() {
  return getRuntime()?.taskTracker || null;
}

/**
 * Send a child-process request to the parent frame.
 *
 * HOST PROTOCOL — preserved verbatim. The parent frame must reply with a
 * window 'message' event whose data is
 *   { type: 'PARENT_CHILD_EXEC_RESPONSE', requestId, payload }
 * where payload is `{ stdout, stderr, exitCode, signal }`.
 *
 * The AbortSignal is optional. This is important because a kill() can happen
 * before the parent responds.
 */
function postToParent(
  type,
  requestId,
  payload,
  timeoutMs = DEFAULT_TIMEOUT,
  signal = null,
) {
  return new Promise((resolve, reject) => {
    let tid;
    let settled = false;

    const cleanup = () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('message', handler);
      }

      if (tid !== undefined) {
        clearTimeout(tid);
        tid = undefined;
      }

      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const handler = (event) => {
      const data = event?.data;

      if (
        data?.requestId !== requestId ||
        data?.type !== 'PARENT_CHILD_EXEC_RESPONSE'
      ) {
        return;
      }

      finishResolve(data.payload || {});
    };

    const onAbort = () => {
      finishReject(
        Object.assign(
          new Error('Process killed'),
          {
            code: 'SIGTERM',
            signal: 'SIGTERM',
            killed: true,
          },
        ),
      );
    };

    if (typeof window === 'undefined') {
      finishReject(
        Object.assign(
          new Error('child_process requires a window environment'),
          { code: 'ERR_NO_WINDOW' },
        ),
      );
      return;
    }

    window.addEventListener('message', handler);

    if (timeoutMs > 0) {
      tid = setTimeout(() => {
        finishReject(
          Object.assign(
            new Error('Process timed out'),
            {
              code: 'ETIMEDOUT',
              signal: 'SIGTERM',
            },
          ),
        );
      }, Math.max(0, Number(timeoutMs) || 0));
    }

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });
    }

    const target = globalThis.parent;

    if (!target || typeof target.postMessage !== 'function') {
      finishReject(
        Object.assign(
          new Error('Parent frame messaging is unavailable'),
          { code: 'ERR_NO_PARENT' },
        ),
      );
      return;
    }

    target.postMessage(
      {
        type,
        requestId,
        payload,
      },
      '*',
    );
  });
}

// ─── ChildProcess ───────────────────────────────────────────────────────────

export class ChildProcess extends EventEmitter {
  constructor() {
    super();

    this.pid = makeFakePid();

    this.connected = false;
    this.killed = false;

    this.exitCode = null;
    this.signalCode = null;

    this.spawnfile = null;
    this.spawnargs = [];

    this.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    this.stdout = new Readable({
      read() {},
    });

    this.stderr = new Readable({
      read() {},
    });

    // Node exposes the stdio trio as an array as well.
    this.stdio = [this.stdin, this.stdout, this.stderr];

    this._ac = new AbortController();

    // NOTE: `send` and `disconnect` are NOT installed here. In Node they
    // exist only on children with an IPC channel (fork()); plain spawn()
    // children have them `undefined`.

    // ── Lifecycle state ──────────────────────────────────────────────────

    this._finalised = false;
    this._stdoutEnded = false;
    this._stderrEnded = false;
    this._exitEmitted = false;
    this._closeEmitted = false;
  }

  // ── Output handling ─────────────────────────────────────────────────────

  _pushStdout(data) {
    if (this._finalised || this._stdoutEnded) {
      return false;
    }

    if (data === undefined || data === null || data === '') {
      return true;
    }

    try {
      this.stdout.push(data, 'utf8');
      return true;
    } catch (err) {
      // A defensive guard for custom Readable implementations.
      if (/after EOF/i.test(String(err?.message))) {
        this._stdoutEnded = true;
        return false;
      }

      throw err;
    }
  }

  _pushStderr(data) {
    if (this._finalised || this._stderrEnded) {
      return false;
    }

    if (data === undefined || data === null || data === '') {
      return true;
    }

    try {
      this.stderr.push(data, 'utf8');
      return true;
    } catch (err) {
      if (/after EOF/i.test(String(err?.message))) {
        this._stderrEnded = true;
        return false;
      }

      throw err;
    }
  }

  _endStdout() {
    if (this._stdoutEnded) {
      return;
    }

    this._stdoutEnded = true;

    try {
      this.stdout.push(null);
    } catch (err) {
      // Custom stream implementations may throw if already ended.
      if (!/after EOF/i.test(String(err?.message))) {
        throw err;
      }
    }
  }

  _endStderr() {
    if (this._stderrEnded) {
      return;
    }

    this._stderrEnded = true;

    try {
      this.stderr.push(null);
    } catch (err) {
      if (!/after EOF/i.test(String(err?.message))) {
        throw err;
      }
    }
  }

  _endStreams() {
    this._endStdout();
    this._endStderr();
  }

  // ── Process lifecycle ───────────────────────────────────────────────────

  _finalise(stdout = '', stderr = '', code = null, sig = null) {
    /*
     * This is the ONLY method allowed to finish a child.
     *
     * kill(), timeout, parent response, and errors can all converge here.
     */
    if (this._finalised) {
      return false;
    }

    /*
     * Do NOT set _finalised until after the final output is delivered.
     *
     * _pushStdout/_pushStderr intentionally ignore output when _finalised
     * is true, so the final output is pushed directly here.
     */
    if (!this._stdoutEnded && stdout) {
      try {
        this.stdout.push(stdout, 'utf8');
      } catch (err) {
        if (!/after EOF/i.test(String(err?.message))) {
          throw err;
        }
        this._stdoutEnded = true;
      }
    }

    if (!this._stderrEnded && stderr) {
      try {
        this.stderr.push(stderr, 'utf8');
      } catch (err) {
        if (!/after EOF/i.test(String(err?.message))) {
          throw err;
        }
        this._stderrEnded = true;
      }
    }

    this._finalised = true;

    this.exitCode = code;
    this.signalCode = sig;

    /*
     * Abort any pending parent request.
     *
     * The promise may already be settled; AbortController is safe here.
     */
    if (!this._ac.signal.aborted) {
      this._ac.abort();
    }

    this._endStreams();

    if (!this._exitEmitted) {
      this._exitEmitted = true;
      this.emit('exit', code, sig);
    }

    if (!this._closeEmitted) {
      this._closeEmitted = true;
      this.emit('close', code, sig);
    }

    return true;
  }

  kill(signal = 'SIGTERM') {
    /*
     * The signal is validated even when the child is already dead, and
     * signal 0 ("test for existence") never terminates the child — both
     * match Node. Like Node, exit/close are delivered asynchronously, so a
     * second kill() before finalization still returns true.
     */
    const sig = signal === 0 ? 0 : convertToValidSignal(signal);

    if (this._finalised) {
      return false;
    }

    this.killed = true;

    if (sig !== 0) {
      const sigName = signalNameOf(sig);
      /*
       * _finalise() owns exit/close and stream EOF.
       * Do NOT emit exit/close directly here.
       */
      queueMicrotask(() => {
        this._finalise('', '', null, sigName);
      });
    }

    return true;
  }

  ref() {
    // Node's ref()/unref() return undefined.
  }

  unref() {
    // Node's ref()/unref() return undefined.
  }
}

/**
 * Install the IPC surface on fork()ed children only — matching Node, where
 * plain spawn() children have `send`/`disconnect` undefined.
 */
function installIPC(target) {
  target.connected = true;

  target.send = function send(message, sendHandle, options, callback) {
    if (typeof sendHandle === 'function') {
      callback = sendHandle;
      sendHandle = undefined;
      options = undefined;
    } else if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }

    // There is no real IPC channel in the browser; report it honestly.
    const err = Object.assign(new Error('Channel closed'), {
      code: 'ERR_IPC_CHANNEL_CLOSED',
    });

    if (typeof callback === 'function') {
      callback(err);
    } else {
      target.emit('error', err);
    }

    return false;
  };

  target.disconnect = function disconnect() {
    if (!target.connected) {
      target.emit(
        'error',
        Object.assign(new Error('IPC channel is already disconnected'), {
          code: 'ERR_IPC_DISCONNECTED',
        }),
      );
      return;
    }

    target.connected = false;
    queueMicrotask(() => target.emit('disconnect'));
  };
}

// ─── Argument normalization (ports of Node's normalize* helpers) ───────────

function normalizeExecArgs(command, options, callback) {
  validateString(command, 'command');
  validateStringNullBytes(command, 'command');

  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }

  // Make a shallow copy so we don't clobber the user's options object.
  // NOTE: spreading a non-object (e.g. a string) is intentional — Node does
  // exactly this, so exec(cmd, 'str', cb) keeps working.
  options = { __proto__: null, ...options };
  options.shell = typeof options.shell === 'string' ? options.shell : true;

  return { file: command, options, callback };
}

function normalizeExecFileArgs(file, args, options, callback) {
  if (Array.isArray(args)) {
    args = args.slice();
  } else if (args != null && typeof args === 'object') {
    callback = options;
    options = args;
    args = null;
  } else if (typeof args === 'function') {
    callback = args;
    options = null;
    args = null;
  }

  args ??= [];

  if (typeof options === 'function') {
    callback = options;
  } else if (options != null) {
    validateObject(options, 'options');
  }

  options ??= {};

  if (callback != null) {
    validateFunction(callback, 'callback');
  }

  // Validate argv0, if present.
  if (options.argv0 != null) {
    validateString(options.argv0, 'options.argv0');
    validateStringNullBytes(options.argv0, 'options.argv0');
  }

  return { file, args, options, callback };
}

function normalizeSpawnArguments(file, args, options) {
  validateString(file, 'file');
  validateStringNullBytes(file, 'file');

  if (file.length === 0) {
    throw errInvalidArgValue('file', file, 'cannot be empty');
  }

  if (Array.isArray(args)) {
    args = args.slice();
  } else if (args == null) {
    args = [];
  } else if (typeof args !== 'object') {
    throw errInvalidArgType('args', 'Object', args);
  } else {
    options = args;
    args = [];
  }

  for (let i = 0; i < args.length; ++i) {
    if (typeof args[i] === 'string') {
      validateStringNullBytes(args[i], `args[${i}]`);
    }
  }

  if (options === undefined) {
    options = {};
  } else {
    validateObject(options, 'options');
  }

  options = { __proto__: null, ...options };
  let cwd = options.cwd;

  // Validate the cwd, if present.
  if (cwd != null) {
    cwd = getValidatedPath(cwd, 'options.cwd');
  }

  // Validate detached, if present.
  if (options.detached != null && typeof options.detached !== 'boolean') {
    throw errInvalidArgType('options.detached', 'boolean', options.detached);
  }

  // Validate the uid, if present.
  if (options.uid != null && !isInt32(options.uid)) {
    throw errInvalidArgType('options.uid', 'int32', options.uid);
  }

  // Validate the gid, if present.
  if (options.gid != null && !isInt32(options.gid)) {
    throw errInvalidArgType('options.gid', 'int32', options.gid);
  }

  // Validate the shell, if present.
  if (options.shell != null &&
      typeof options.shell !== 'boolean' &&
      typeof options.shell !== 'string') {
    throw errInvalidArgType('options.shell', ['boolean', 'string'], options.shell);
  }

  // Validate argv0, if present.
  if (options.argv0 != null) {
    validateString(options.argv0, 'options.argv0');
    validateStringNullBytes(options.argv0, 'options.argv0');
  }

  // Validate windowsHide, if present.
  if (options.windowsHide != null && typeof options.windowsHide !== 'boolean') {
    throw errInvalidArgType('options.windowsHide', 'boolean', options.windowsHide);
  }

  // Validate windowsVerbatimArguments, if present.
  if (options.windowsVerbatimArguments != null &&
      typeof options.windowsVerbatimArguments !== 'boolean') {
    throw errInvalidArgType(
      'options.windowsVerbatimArguments', 'boolean', options.windowsVerbatimArguments);
  }

  // Validate stdio strings, if present. (Full stdio descriptor validation is
  // native-only; the parent host interprets the value.)
  if (typeof options.stdio === 'string' &&
      !['pipe', 'ignore', 'inherit'].includes(options.stdio)) {
    throw errInvalidArgValue('stdio', options.stdio);
  }

  if (options.shell) {
    if (typeof options.shell === 'string') {
      validateStringNullBytes(options.shell, 'options.shell');
    }
    const command = args.length > 0 ? `${file} ${args.join(' ')}` : file;
    if (typeof options.shell === 'string') {
      file = options.shell;
    } else {
      file = '/bin/sh';
    }
    args = ['-c', command];
  }

  const spawnargs = [
    typeof options.argv0 === 'string' ? options.argv0 : file,
    ...args,
  ];

  // Validate env keys/values for null bytes last, like Node (the property
  // name embeds the raw key: `options.env['KEY']`).
  const env = options.env;
  if (env !== null && env !== undefined && typeof env === 'object') {
    for (const key in env) {
      const value = env[key];
      if (value !== undefined) {
        validateStringNullBytes(key, `options.env['${key}']`);
        validateStringNullBytes(value, `options.env['${key}']`);
      }
    }
  }

  return {
    // Make a shallow copy so we don't clobber the user's options object.
    __proto__: null,
    ...options,
    args,
    cwd,
    detached: !!options.detached,
    file,
    spawnargs,
    windowsHide: !!options.windowsHide,
    windowsVerbatimArguments: !!options.windowsVerbatimArguments,
  };
}

/**
 * Node's execFile() delegates to spawn() with a fixed subset of options —
 * and coerces windowsHide/windowsVerbatimArguments with !! first, so bad
 * values there never reach validation. This mirrors that subset exactly.
 */
function validateSpawnSubset(file, args, opts) {
  const spawnNorm = normalizeSpawnArguments(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    gid: opts.gid,
    shell: opts.shell,
    signal: opts.signal,
    uid: opts.uid,
    windowsHide: !!opts.windowsHide,
    windowsVerbatimArguments: !!opts.windowsVerbatimArguments,
  });
  validateTimeout(spawnNorm.timeout);
  validateAbortSignal(spawnNorm.signal, 'options.signal');
  sanitizeKillSignal(spawnNorm.killSignal);
}

/**
 * Shared option validation for the exec family (Node validates these in
 * execFile before spawning).
 */
function validateExecOptions(options, callback) {
  // Validate the timeout, if present.
  validateTimeout(options.timeout);

  // Validate maxBuffer, if present.
  validateMaxBuffer(options.maxBuffer);

  // Validate and translate the kill signal, if present.
  options.killSignal = sanitizeKillSignal(options.killSignal);

  validateAbortSignal(options.signal, 'options.signal');

  if (callback != null) {
    validateFunction(callback, 'callback');
  }
}

/*
 * Preserve arguments as safely as possible.
 *
 * This shim ultimately delegates to a shell/parent runtime, so quote
 * arguments rather than simply joining them. (Host protocol: execFile is
 * delivered as PARENT_EXEC_REQUEST with a single shell command string.)
 */
function quoteArg(value) {
  const string = String(value);

  if (string === '') {
    return "''";
  }

  return `'${string.replace(/'/g, `'\\''`)}'`;
}

// ─── exec core (shared by exec/execFile, host protocol preserved) ───────────

function execCore(command, options, callback) {
  const child = new ChildProcess();

  child.spawnfile = '/bin/sh';
  child.spawnargs = ['/bin/sh', '-c', command];

  /*
   * Node emits 'spawn' asynchronously after the child has been created.
   */
  queueMicrotask(() => {
    if (!child._finalised) {
      child.emit('spawn');
    }
  });

  const requestId = makeRequestId();
  const encoding = resolveEncoding(options.encoding);
  const maxBuffer = options.maxBuffer ?? MAX_BUFFER;
  const killSignal = options.killSignal;

  wireAbortSignal(options.signal, child, killSignal);

  postToParent(
    'PARENT_EXEC_REQUEST',
    requestId,
    {
      command,
      options,
    },
    options.timeout ?? DEFAULT_TIMEOUT,
    child._ac.signal,
  )
    .then((result = {}) => {
      /*
       * kill() or timeout may have already finalized the child.
       */
      if (child._finalised) {
        return;
      }

      let stdout = result.stdout ?? '';
      let stderr = result.stderr ?? '';
      if (typeof stdout !== 'string') stdout = String(stdout);
      if (typeof stderr !== 'string') stderr = String(stderr);
      const exitCode = result.exitCode ?? 0;
      const signal = result.signal ?? null;

      let execError = null;
      let finalCode = exitCode;
      let finalSignal = signal;

      // Node truncates output, kills the child, and reports
      // ERR_CHILD_PROCESS_STDIO_MAXBUFFER when maxBuffer is exceeded.
      if (stdout.length > maxBuffer) {
        stdout = stdout.slice(0, maxBuffer);
        execError = errStdioMaxBuffer('stdout');
        child.killed = true;
        finalCode = null;
        finalSignal = signalNameOf(killSignal ?? 'SIGTERM');
      } else if (stderr.length > maxBuffer) {
        stderr = stderr.slice(0, maxBuffer);
        execError = errStdioMaxBuffer('stderr');
        child.killed = true;
        finalCode = null;
        finalSignal = signalNameOf(killSignal ?? 'SIGTERM');
      }

      if (
        !execError &&
        ((exitCode !== null && exitCode !== 0) || signal)
      ) {
        execError = new Error(
          `Command failed: ${command}\n${stderr}`,
        );

        execError.code = exitCode ?? undefined;
        execError.killed = child.killed;
        execError.signal = signal;
        execError.cmd = command;

        // NOTE: Node does NOT emit 'error' on the child for a failed
        // command — the error goes to the callback only.
      }

      const out = toOutput(stdout, encoding);
      const errOut = toOutput(stderr, encoding);

      child._finalise(out, errOut, finalCode, finalSignal);

      callback?.(
        execError,
        out,
        errOut,
      );
    })
    .catch((err) => {
      /*
       * Abort caused by kill() is expected.
       * kill() has already finalized the child.
       */
      if (child._finalised) {
        return;
      }

      const wrapped =
        err instanceof Error
          ? err
          : new Error(String(err));

      if (wrapped.code === 'ETIMEDOUT') {
        child.killed = true;
      }

      child.emit('error', wrapped);

      child._finalise(
        '',
        wrapped.message,
        wrapped.code === 'ETIMEDOUT' ? null : 1,
        wrapped.signal ?? null,
      );

      callback?.(
        wrapped,
        toOutput('', encoding),
        toOutput(wrapped.message, encoding),
      );
    });

  return child;
}

/**
 * Wire an options.signal AbortSignal to the child, like Node's spawn():
 * aborting kills the child with killSignal and emits an AbortError.
 */
function wireAbortSignal(signal, child, killSignal) {
  if (signal == null) {
    return;
  }

  const onAbort = () => {
    if (child._finalised) {
      return;
    }
    try {
      if (child.kill(killSignal === undefined ? 'SIGTERM' : killSignal)) {
        child.emit('error', new AbortError(signal.reason));
      }
    } catch (err) {
      child.emit('error', err);
    }
  };

  if (signal.aborted) {
    queueMicrotask(onAbort);
  } else if (typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('exit', () => {
      signal.removeEventListener('abort', onAbort);
    });
  }
}

// ─── exec ───────────────────────────────────────────────────────────────────

function _exec(command, options, callback) {
  // Node's exec() is execFile() with a forced shell: exec() normalizes its
  // own args, then calls execFile(file, options-spread, callback), so the
  // options object lands in execFile's `args` position and is re-normalized
  // there (this is where argv0/callback validation happens, and why
  // exec(cmd, 'str', cb) does not throw). Replicate the delegation exactly.
  const norm = normalizeExecArgs(command, options, callback);
  const fileNorm = normalizeExecFileArgs(norm.file, norm.options, norm.callback);

  const opts = {
    __proto__: null,
    encoding: 'utf8',
    timeout: 0,
    maxBuffer: MAX_BUFFER,
    killSignal: 'SIGTERM',
    ...fileNorm.options,
  };
  validateExecOptions(opts, fileNorm.callback);

  // Node's execFile() delegates to spawn(): spawn-level validation applies
  // to the forwarded subset of options.
  validateSpawnSubset(norm.file, [], opts);

  return execCore(norm.file, opts, fileNorm.callback);
}

// ─── execFile ───────────────────────────────────────────────────────────────

function _execFile(file, args, options, callback) {
  const norm = normalizeExecFileArgs(file, args, options, callback);

  const opts = {
    __proto__: null,
    encoding: 'utf8',
    timeout: 0,
    maxBuffer: MAX_BUFFER,
    killSignal: 'SIGTERM',
    cwd: null,
    env: null,
    shell: false,
    ...norm.options,
  };
  validateExecOptions(opts, norm.callback);

  // Node's execFile() delegates to spawn(): spawn-level validation applies
  // to the file, args, and the forwarded subset of options. (Validation
  // only — the shim still delivers execFile as PARENT_EXEC_REQUEST with a
  // single shell-quoted command string, per the host protocol.)
  validateSpawnSubset(norm.file, norm.args, opts);

  const command = [norm.file, ...norm.args].map(quoteArg).join(' ');

  return execCore(command, opts, norm.callback);
}

// ─── spawn ──────────────────────────────────────────────────────────────────

function _spawn(file, args, options) {
  const norm = normalizeSpawnArguments(file, args, options);
  validateTimeout(norm.timeout);
  validateAbortSignal(norm.signal, 'options.signal');
  const killSignal = sanitizeKillSignal(norm.killSignal);

  const child = new ChildProcess();

  child.spawnfile = norm.file;
  child.spawnargs = norm.spawnargs;

  /*
   * Node emits 'spawn' asynchronously after the child has been created.
   */
  queueMicrotask(() => {
    if (!child._finalised) {
      child.emit('spawn');
    }
  });

  const requestId = makeRequestId();

  wireAbortSignal(norm.signal, child, killSignal);

  postToParent(
    'PARENT_SPAWN_REQUEST',
    requestId,
    {
      command: norm.file,
      args: norm.args,
      options: norm,
    },
    norm.timeout ?? DEFAULT_TIMEOUT,
    child._ac.signal,
  )
    .then((result = {}) => {
      /*
       * kill() may have won the race.
       */
      if (child._finalised) {
        return;
      }

      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      const exitCode = result.exitCode ?? 0;
      const signal = result.signal ?? null;

      if (
        (exitCode !== null && exitCode !== 0) ||
        signal
      ) {
        const err = new Error(
          `spawn ${norm.file} failed`,
        );

        err.code = exitCode ?? undefined;
        err.killed = child.killed;
        err.signal = signal;

        child.emit('error', err);
      }

      child._finalise(
        stdout,
        stderr,
        exitCode,
        signal,
      );
    })
    .catch((err) => {
      /*
       * If kill() already finalized the child, there is nothing left
       * for the rejected request to do.
       */
      if (child._finalised) {
        return;
      }

      const wrapped =
        err instanceof Error
          ? err
          : new Error(String(err));

      if (wrapped.code === 'ETIMEDOUT') {
        child.killed = true;
      }

      child.emit('error', wrapped);

      child._finalise(
        '',
        wrapped.message,
        wrapped.code === 'ETIMEDOUT' ? null : 1,
        wrapped.signal ?? null,
      );
    });

  return child;
}

// ─── fork ───────────────────────────────────────────────────────────────────

/**
 * Browser noop: a real Node subprocess can never exist here.
 *
 * Validates arguments exactly like Node, then returns a live-but-idle
 * ChildProcess with the IPC surface installed (connected: true,
 * send()/disconnect() present — unlike plain spawn() children). send()
 * reports ERR_IPC_CHANNEL_CLOSED because there is no real channel; the
 * child never exits on its own — kill() it when done.
 */
/**
 * Node's fork() defaults execPath/execArgv from the current process.
 * In Jared's sandbox those come from the runtime config (`_RUNTIME_.process`);
 * under real Node (parity tests) from the global process.
 */
function defaultExecPath() {
  const rt = getRuntime();
  const fromRuntime = rt && rt.process ? rt.process.execPath : undefined;
  if (typeof fromRuntime === 'string' && fromRuntime) return fromRuntime;
  const gp = typeof globalThis.process === 'object' && globalThis.process !== null
    ? globalThis.process.execPath
    : undefined;
  if (typeof gp === 'string' && gp) return gp;
  return 'node';
}

function defaultExecArgv() {
  const rt = getRuntime();
  const fromRuntime = rt && rt.process ? rt.process.execArgv : undefined;
  if (Array.isArray(fromRuntime)) return fromRuntime;
  const gp = typeof globalThis.process === 'object' && globalThis.process !== null
    ? globalThis.process.execArgv
    : undefined;
  if (Array.isArray(gp)) return gp;
  return [];
}

export function fork(modulePath, args, options) {
  modulePath = getValidatedPath(modulePath, 'modulePath');

  // Get options and args arguments.
  if (args == null) {
    args = [];
  } else if (typeof args === 'object' && !Array.isArray(args)) {
    options = args;
    args = [];
  } else {
    validateArray(args, 'args');
  }

  if (options != null) {
    validateObject(options, 'options');
  }
  options = { __proto__: null, ...options, shell: false };

  const execPath = options.execPath || defaultExecPath();
  validateStringNullBytes(execPath, 'options.execPath');
  validateString(execPath, 'file');
  const execArgv = options.execArgv || defaultExecArgv();
  for (let i = 0; i < execArgv.length; ++i) {
    validateStringNullBytes(execArgv[i], `options.execArgv[${i}]`);
  }

  const norm = normalizeSpawnArguments(
    execPath, [...execArgv, modulePath, ...args], options);

  // ─── In-realm fork (almostnode-style) ───
  // A "forked process" is a fresh module scope in the same JS realm.
  // No Web Worker, no iframe. The worker entry runs via the runtime's
  // loadModule, with a per-fork `process` object providing IPC.
  const child = new ChildProcess();
  child.spawnfile = norm.file;
  child.spawnargs = norm.spawnargs;

  // Serialized async IPC queue. Real IPC crosses a process boundary, so
  // messages arrive in order and handlers finish before the next message.
  // In one realm, EventEmitter.emit is fire-and-forget — without this,
  // vitest's onTaskUpdate would land before async onCollected finished.
  let ipcQueue = Promise.resolve();
  const cloneMsg = (msg) => {
    try {
      return structuredClone(msg);
    } catch {
      // structuredClone fails on functions etc.; fall back to shallow copy
      return msg && typeof msg === 'object' ? { ...msg } : msg;
    }
  };

  // Child-side process object. The worker entry (e.g. vitest's forks.js)
  // uses process.on('message') and process.send() directly.
  const childProcess = {
    // Copy parent process props
    ...globalThis.process,
    argv: ['node', modulePath, ...args],
    execPath,
    execArgv,
    // IPC: child -> parent
    send: (message, sendHandle, opts, callback) => {
      if (typeof sendHandle === 'function') callback = sendHandle;
      const cloned = cloneMsg(message);
      ipcQueue = ipcQueue.then(async () => {
        for (const listener of child.listeners('message')) {
          try {
            const result = listener(cloned);
            if (result && typeof result.then === 'function') await result;
          } catch (err) {
            child.emit('error', err);
          }
        }
      });
      if (typeof callback === 'function') {
        ipcQueue.then(() => callback(null)).catch(callback);
      }
      return true;
    },
    disconnect: () => {
      child.connected = false;
      child.emit('disconnect');
    },
    connected: true,
  };

  // Parent-side: child.send(message) -> child's process 'message' event
  // We need an EventEmitter for the child's process 'message' listeners.
  // Since childProcess is a plain object, add on/once/removeListener.
  const childMsgListeners = new Set();
  childProcess.on = childProcess.addListener = (event, listener) => {
    if (event === 'message') childMsgListeners.add(listener);
    return childProcess;
  };
  childProcess.once = (event, listener) => {
    if (event === 'message') {
      const wrapper = (...a) => {
        childMsgListeners.delete(wrapper);
        return listener(...a);
      };
      childMsgListeners.add(wrapper);
    }
    return childProcess;
  };
  childProcess.removeListener = (event, listener) => {
    if (event === 'message') childMsgListeners.delete(listener);
    return childProcess;
  };

  // Parent -> child IPC (serialized, cloned)
  let parentToChildQueue = Promise.resolve();
  child.send = function send(message, sendHandle, options, callback) {
    if (typeof sendHandle === 'function') {
      callback = sendHandle;
      sendHandle = undefined;
      options = undefined;
    } else if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (!child.connected) {
      const err = Object.assign(new Error('Channel closed'), {
        code: 'ERR_IPC_CHANNEL_CLOSED',
      });
      if (typeof callback === 'function') callback(err);
      else child.emit('error', err);
      return false;
    }
    const cloned = cloneMsg(message);
    parentToChildQueue = parentToChildQueue.then(async () => {
      for (const listener of [...childMsgListeners]) {
        try {
          const result = listener(cloned);
          if (result && typeof result.then === 'function') await result;
        } catch (err) {
          // Child listener threw; emit on child process if it has emit
          console.error('[fork child] message listener error:', err);
        }
      }
    });
    if (typeof callback === 'function') {
      parentToChildQueue.then(() => callback(null)).catch(callback);
    }
    return true;
  };
  child.connected = true;
  const _prevProcess = globalThis.process;
  // Store prevProcess for restoration (set in the queueMicrotask below,
  // but capture the reference now for the disconnect closure)
  child.disconnect = () => {
    // Match Node.js: second disconnect() emits 'error' with ERR_IPC_DISCONNECTED (does not throw)
    // See lib/internal/child_process.js: target.disconnect = function() { if (!this.connected) { this.emit('error', new ERR_IPC_DISCONNECTED()); return; } ... }
    if (!child.connected) {
      child.emit(
        'error',
        Object.assign(new Error('IPC channel is already disconnected'), {
          code: 'ERR_IPC_DISCONNECTED',
        }),
      );
      return;
    }
    child.connected = false;
    childProcess.connected = false;
    // Restore parent process if this fork's process is still active
    if (globalThis.process === childProcess) {
      globalThis.process = _prevProcessForRestore;
    }
    child.emit('disconnect');
  };
  // Updated in queueMicrotask to the actual previous process
  let _prevProcessForRestore = _prevProcess;

  // Load the worker entry in a fresh module scope with the child's process.
  // We temporarily swap globalThis.process; the module's top-level code
  // runs synchronously during import(), so the swap is safe for init.
  // Async continuations use the child's process via closure (childProcess).
  queueMicrotask(async () => {
    const prevProcess = globalThis.process;
    _prevProcessForRestore = prevProcess;
    globalThis.process = childProcess;
    try {
      const rt = getRuntime();
      if (rt && typeof rt.loadModule === 'function') {
        await rt.loadModule(modulePath, 'import', null, null);
      } else {
        // Fallback: dynamic import (for parity tests under real Node)
        await import(modulePath);
      }
      child.emit('spawn');
    } catch (err) {
      child.emit('error', err);
    }
    // NOTE: Do NOT restore globalThis.process here. The worker's async
    // message handlers reference the global `process`, so the child's
    // process must remain active for the lifetime of the fork.
    // It is restored on child.disconnect() or child.kill().
    // LIMITATION (v1): Only one fork's process can be active at a time.
    // A second fork() will overwrite the first's process object.
  });

  return child;
}

// ─── Sync noops ─────────────────────────────────────────────────────────────

/**
 * Browser noop: synchronous subprocesses are impossible (postMessage is
 * async). Arguments are validated exactly like Node; the result shape
 * matches Node's SpawnSyncReturns (`{ status, signal, output, pid, stdout,
 * stderr }` — no `error` key on success).
 */
export function spawnSync(file, args, options) {
  const norm = normalizeSpawnArguments(file, args, options);

  // Validate the timeout, if present.
  validateTimeout(norm.timeout);

  // Validate maxBuffer, if present.
  const maxBuffer = norm.maxBuffer ?? MAX_BUFFER;
  validateMaxBuffer(maxBuffer);

  // Validate and translate the kill signal, if present.
  sanitizeKillSignal(norm.killSignal);

  validateAbortSignal(norm.signal, 'options.signal');

  const encoding = resolveEncoding(norm.encoding ?? 'buffer');
  const stdout = toOutput('', encoding);
  const stderr = toOutput('', encoding);

  return {
    status: 0,
    signal: null,
    output: [null, stdout, stderr],
    pid: makeFakePid(),
    stdout,
    stderr,
  };
}

/**
 * Browser noop: validates like Node, returns the empty stdout.
 * (Node's execSync throws checkExecSyncError on failure; the noop never
 * runs anything, so it returns empty output.)
 */
export function execSync(command, options) {
  const norm = normalizeExecArgs(command, options, null);
  return spawnSync(norm.file, norm.options).stdout;
}

/**
 * Browser noop: validates like Node, returns the empty stdout.
 */
export function execFileSync(file, args, options) {
  const norm = normalizeExecFileArgs(file, args, options);
  return spawnSync(norm.file, norm.args, norm.options).stdout;
}

// ─── promisify.custom ───────────────────────────────────────────────────────

const kPromisifyCustom = Symbol.for('nodejs.util.promisify.custom');

function customPromiseExecFunction(orig, name) {
  const fn = function (...args) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    promise.child = orig(...args, (err, stdout, stderr) => {
      if (err !== null && err !== undefined) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });

    return promise;
  };
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  return fn;
}

// ─── Task tracker integration ───────────────────────────────────────────────

const originalExec = _exec;
const originalExecFile = _execFile;
const originalSpawn = _spawn;

function patchChildProcess(fn) {
  const tracker = getTaskTracker();

  if (
    tracker &&
    typeof tracker.patchChildProcess === 'function'
  ) {
    return tracker.patchChildProcess(fn);
  }

  return fn;
}

export const exec = patchChildProcess(originalExec);
export const execFile = patchChildProcess(originalExecFile);
export const spawn = patchChildProcess(originalSpawn);

Object.defineProperty(exec, kPromisifyCustom, {
  __proto__: null,
  enumerable: false,
  configurable: true,
  writable: true,
  value: customPromiseExecFunction(exec, 'exec'),
});
Object.defineProperty(execFile, kPromisifyCustom, {
  __proto__: null,
  enumerable: false,
  configurable: true,
  writable: true,
  value: customPromiseExecFunction(execFile, 'execFile'),
});

// ─── Default export ─────────────────────────────────────────────────────────

// Node's internal `_forkChild(fd, target)` entry point for a forked child.
// Impossible in a browser (no process spawning): honest noop stub that
// returns false, per the repo's noop-over-throw rule.
export function _forkChild(_fd, _target) {
  return false;
}

export default {
  ChildProcess,
  exec,
  execFile,
  execFileSync,
  execSync,
  fork,
  spawn,
  spawnSync,
  _forkChild,
};
