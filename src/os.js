/*!
 * os-web — node:os for browsers & bundlers.
 *
 * Faithful ESM port of Node.js v24.20.0 `lib/os.js`.
 * Dependency-free, browser-safe.
 *
 * Design — two layers:
 *  1. JS layer (this file): ported 1:1 from Node's lib/os.js — the same
 *     exported function set, the same `Symbol.toPrimitive` coercion
 *     wrappers, the same property descriptors for `EOL`/`devNull`/
 *     `constants`, and the same `validateInt32` argument checking (with
 *     `ERR_INVALID_ARG_TYPE` / `ERR_OUT_OF_RANGE` codes) for
 *     `getPriority`/`setPriority`.
 *  2. Data-source layer: when running under genuine Node (the parity
 *     harness, or plain `node` — detected via `process.versions.node`
 *     plus the absence of a *browser* `navigator.userAgent`), OS data
 *     comes from the real builtin via `process.getBuiltinModule('os')`
 *     (the "native bridge"). When browser globals exist (real browsers,
 *     edge runtimes, or the mocked repo tests), dependency-free
 *     heuristic/stub fallbacks are used instead — the original os-web
 *     behavior. `process.getBuiltinModule` never enters a browser bundle
 *     as anything but a guarded, undefined lookup.
 *
 * Deviations from Node (documented, test-pinned):
 *  - `constants` is fully frozen; Node freezes only `constants.signals`.
 *    The repo's own test asserts `Object.isFrozen(os.constants)`.
 *  - `os.constants.errno` values are the Linux/libuv table embedded
 *    below (verbatim from v24.20.0); errno numbers are platform-specific
 *    in general, but the table is what Node ships on Linux.
 *  - Browser fallbacks: `arch`/`platform`/`type`/`release`/`version`/
 *    `machine` are UA heuristics; `freemem`/`totalmem` are stubs;
 *    `loadavg()` is `[0, 0, 0]`; `cpus()` stubs `times` as zeros;
 *    `networkInterfaces()` is loopback-only; `uptime()` counts from
 *    `performance.now()`; `userInfo()` returns a stub (uid/gid `-1`,
 *    like Node on Windows); `getPriority`/`setPriority` are no-ops.
 */

// ---------------------------------------------------------------------------
// Minimal ports of Node's internal error codes used by lib/os.js.
// Only the `code` property and the message prefix are asserted by the
// official tests; the "Received ..." suffix is best-effort.
// ---------------------------------------------------------------------------

function _inspectArg(value) {
  if (value === null || value === undefined) return `${value}`;
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'function') return `function ${value.name || 'anonymous'}`;
  if (typeof value === 'object') {
    const name = value.constructor && value.constructor.name;
    return `an instance of ${name || 'Object'}`;
  }
  return `type ${typeof value} (${String(value)})`;
}

class ERR_INVALID_ARG_TYPE extends TypeError {
  constructor(name, expected, actual) {
    super(
      `The "${name}" argument must be of type ${expected}. ` +
      `Received ${_inspectArg(actual)}`,
    );
    this.code = 'ERR_INVALID_ARG_TYPE';
  }
}

class ERR_OUT_OF_RANGE extends RangeError {
  constructor(name, range, actual) {
    super(
      `The value of "${name}" is out of range. It must be ${range}. ` +
      `Received ${_inspectArg(actual)}`,
    );
    this.code = 'ERR_OUT_OF_RANGE';
  }
}

// Port of `validateInt32` from Node v24.20.0 lib/internal/validators.js.
function validateInt32(value, name, min = -2147483648, max = 2147483647) {
  if (typeof value !== 'number') {
    throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  }
  if (!Number.isInteger(value)) {
    throw new ERR_OUT_OF_RANGE(name, 'an integer', value);
  }
  if (value < min || value > max) {
    throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
  }
}

// ---------------------------------------------------------------------------
// Native bridge — real OS data when running under Node without browser
// globals. `process.getBuiltinModule('os')` bypasses the module loader, so
// there is no recursion even when this file stands in for `require('os')`.
//
// The bridge activates only in genuine Node runtimes: Node v21+ ships a
// global `navigator` whose `userAgent` starts with `'Node.js/'`, so the
// gate treats that as "not a browser". A real (or mocked) browser UA —
// e.g. the repo tests' `navigator` mocks — selects the fallbacks below.
// ---------------------------------------------------------------------------

const _uaString =
  typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '';
const _hasBrowserNavigator =
  _uaString !== '' && !_uaString.startsWith('Node.js/');

const _nativeOs =
  !_hasBrowserNavigator &&
  typeof process !== 'undefined' &&
  process.versions != null &&
  typeof process.versions.node === 'string' &&
  typeof process.getBuiltinModule === 'function'
    ? process.getBuiltinModule('os')
    : null;

// ---------------------------------------------------------------------------
// Browser fallback helpers (original os-web heuristics, kept as-is).
// Environment detection uses `navigator` / `performance` / `location`
// globals — never `typeof window` — so the shim works in Web Workers too.
// ---------------------------------------------------------------------------

const _ua =
  typeof navigator !== 'undefined'
    ? (navigator.userAgent || '').toLowerCase()
    : '';

const _nplatform =
  typeof navigator !== 'undefined'
    ? (navigator.platform || '').toLowerCase()
    : '';

/** Infer a Node-style `process.platform` value from UA / navigator.platform. */
function _inferPlatform() {
  if (_nplatform.startsWith('win') || _ua.includes('windows')) return 'win32';
  if (_nplatform.startsWith('mac') || _ua.includes('mac os'))  return 'darwin';
  return 'linux';
}

/** Infer a Node-style `process.arch` value from the UA string. */
function _inferArch() {
  if (_ua.includes('aarch64') || _ua.includes('arm64'))          return 'arm64';
  if (_ua.includes('armv') || (_ua.includes('arm') && !_ua.includes('arm64'))) return 'arm';
  if (_ua.includes('x86_64') || _ua.includes('win64') ||
      _ua.includes('amd64'))                                      return 'x64';
  if (_ua.includes('i686') || _ua.includes('i386') ||
      _ua.includes('x86'))                                        return 'ia32';
  return 'x64'; // safe fallback
}

/** Map platform → uname-style type string (matches Node os.type() output). */
function _inferType() {
  const p = _inferPlatform();
  if (p === 'win32')  return 'Windows_NT';
  if (p === 'darwin') return 'Darwin';
  return 'Linux';
}

/** Map platform → uname-style machine string (matches Node os.machine()). */
function _inferMachine() {
  const a = _inferArch();
  const map = { x64: 'x86_64', ia32: 'i686', arm64: 'aarch64', arm: 'armv7l' };
  return map[a] || a;
}

function _inferRelease() {
  return typeof navigator !== 'undefined'
    ? (navigator.appVersion || '5.10.0')
    : '5.10.0';
}

/** Read env vars without crashing where `process.env` is unavailable. */
function _getEnv() {
  return (typeof process !== 'undefined' && process.env) || {};
}

// ---------------------------------------------------------------------------
// Platform flag. Real `process.platform` wins when present (Node, Bun,
// Deno, and bundler shims); otherwise fall back to the UA heuristic.
// ---------------------------------------------------------------------------

const _isWindows =
  (typeof process !== 'undefined' && process.platform === 'win32') ||
  _inferPlatform() === 'win32';

// os.constants tables extracted verbatim from Node.js v24.20.0
// (internalBinding('constants').os). Like Node's binding objects, these
// use null-prototype objects.
const _kUvUdpReuseaddr = Object.freeze(Object.assign(Object.create(null), {
  UV_UDP_REUSEADDR: 4,
}));
const _kDlopen = Object.freeze(Object.assign(Object.create(null), {
  RTLD_LAZY: 1,
  RTLD_NOW: 2,
  RTLD_GLOBAL: 256,
  RTLD_LOCAL: 0,
  RTLD_DEEPBIND: 8,
}));
const _kErrno = Object.freeze(Object.assign(Object.create(null), {
  E2BIG: 7,
  EACCES: 13,
  EADDRINUSE: 98,
  EADDRNOTAVAIL: 99,
  EAFNOSUPPORT: 97,
  EAGAIN: 11,
  EALREADY: 114,
  EBADF: 9,
  EBADMSG: 74,
  EBUSY: 16,
  ECANCELED: 125,
  ECHILD: 10,
  ECONNABORTED: 103,
  ECONNREFUSED: 111,
  ECONNRESET: 104,
  EDEADLK: 35,
  EDESTADDRREQ: 89,
  EDOM: 33,
  EDQUOT: 122,
  EEXIST: 17,
  EFAULT: 14,
  EFBIG: 27,
  EHOSTUNREACH: 113,
  EIDRM: 43,
  EILSEQ: 84,
  EINPROGRESS: 115,
  EINTR: 4,
  EINVAL: 22,
  EIO: 5,
  EISCONN: 106,
  EISDIR: 21,
  ELOOP: 40,
  EMFILE: 24,
  EMLINK: 31,
  EMSGSIZE: 90,
  EMULTIHOP: 72,
  ENAMETOOLONG: 36,
  ENETDOWN: 100,
  ENETRESET: 102,
  ENETUNREACH: 101,
  ENFILE: 23,
  ENOBUFS: 105,
  ENODATA: 61,
  ENODEV: 19,
  ENOENT: 2,
  ENOEXEC: 8,
  ENOLCK: 37,
  ENOLINK: 67,
  ENOMEM: 12,
  ENOMSG: 42,
  ENOPROTOOPT: 92,
  ENOSPC: 28,
  ENOSR: 63,
  ENOSTR: 60,
  ENOSYS: 38,
  ENOTCONN: 107,
  ENOTDIR: 20,
  ENOTEMPTY: 39,
  ENOTSOCK: 88,
  ENOTSUP: 95,
  ENOTTY: 25,
  ENXIO: 6,
  EOPNOTSUPP: 95,
  EOVERFLOW: 75,
  EPERM: 1,
  EPIPE: 32,
  EPROTO: 71,
  EPROTONOSUPPORT: 93,
  EPROTOTYPE: 91,
  ERANGE: 34,
  EROFS: 30,
  ESPIPE: 29,
  ESRCH: 3,
  ESTALE: 116,
  ETIME: 62,
  ETIMEDOUT: 110,
  ETXTBSY: 26,
  EWOULDBLOCK: 11,
  EXDEV: 18,
}));
const _kSignals = Object.freeze(Object.assign(Object.create(null), {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGIOT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGCHLD: 17,
  SIGSTKFLT: 16,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPOLL: 29,
  SIGPWR: 30,
  SIGSYS: 31,
}));
const _kPriority = Object.freeze(Object.assign(Object.create(null), {
  PRIORITY_LOW: 19,
  PRIORITY_BELOW_NORMAL: 10,
  PRIORITY_NORMAL: 0,
  PRIORITY_ABOVE_NORMAL: -7,
  PRIORITY_HIGH: -14,
  PRIORITY_HIGHEST: -20,
}));

// ---------------------------------------------------------------------------
// Assemble `os.constants`. Node freezes only `constants.signals`; this
// port freezes the whole object because the repo's own test suite asserts
// `Object.isFrozen(os.constants)`.
// ---------------------------------------------------------------------------

export const constants = Object.freeze(Object.assign(Object.create(null), {
  UV_UDP_REUSEADDR: _kUvUdpReuseaddr.UV_UDP_REUSEADDR,
  dlopen: _kDlopen,
  errno: _kErrno,
  signals: _kSignals,
  priority: _kPriority,
}));

// ---------------------------------------------------------------------------
// EOL / devNull — platform-varying constants.
// ---------------------------------------------------------------------------

const _EOL = _isWindows ? '\r\n' : '\n';
const _devNull = _isWindows ? '\\\\.\\nul' : '/dev/null';

/** Operating-system-specific end-of-line marker. */
export const EOL = _EOL;
/** Platform-specific path of the null device. */
export const devNull = _devNull;

// ---------------------------------------------------------------------------
// Exported functions — ported from Node v24.20.0 lib/os.js, including the
// `Symbol.toPrimitive` coercion wrappers Node attaches (so `+os.totalmem`
// and `` `${os.hostname}` `` keep working).
// ---------------------------------------------------------------------------

/** CPU architecture. Node returns `process.arch`; browsers use a heuristic. */
export function arch() {
  return _nativeOs ? _nativeOs.arch() : _inferArch();
}
arch[Symbol.toPrimitive] = () => arch();

/** OS platform. Node returns `process.platform`; browsers use a heuristic. */
export function platform() {
  return _nativeOs ? _nativeOs.platform() : _inferPlatform();
}
platform[Symbol.toPrimitive] = () => platform();

/**
 * Default directory for temporary files. Pure-JS port of Node's algorithm:
 * on Windows `TEMP`/`TMP`/`SystemRoot||windir + '\\temp'` (trailing
 * backslash stripped unless a drive root); on POSIX `TMPDIR`/`TMP`/`TEMP`
 * with a single trailing slash stripped (mirroring the C++ GetTempDir
 * binding), falling back to `'/tmp'`.
 */
export function tmpdir() {
  const env = _getEnv();
  if (_isWindows) {
    const p = env.TEMP || env.TMP ||
      (env.SystemRoot || env.windir || 'C:\\Windows') + '\\temp';
    if (p.length > 1 && p[p.length - 1] === '\\' && p[p.length - 2] !== ':') {
      return p.slice(0, -1);
    }
    return p;
  }
  const dir = env.TMPDIR || env.TMP || env.TEMP;
  if (dir) {
    if (dir.length > 1 && dir.endsWith('/')) return dir.slice(0, -1);
    return dir;
  }
  return '/tmp';
}
tmpdir[Symbol.toPrimitive] = () => tmpdir();

const _kEndianness = (() => {
  const buf = new ArrayBuffer(2);
  new Uint16Array(buf)[0] = 0x0102;
  return new Uint8Array(buf)[0] === 0x01 ? 'BE' : 'LE';
})();

/** CPU endianness, probed with a typed array — exact, not a heuristic. */
export function endianness() {
  return _kEndianness;
}
endianness[Symbol.toPrimitive] = () => _kEndianness;

/** Hostname. Browsers fall back to `location.hostname` / `'localhost'`. */
export function hostname() {
  if (_nativeOs) return _nativeOs.hostname();
  return typeof location !== 'undefined'
    ? (location.hostname || 'localhost')
    : 'localhost';
}
hostname[Symbol.toPrimitive] = () => hostname();

/** Current user's home directory. */
export function homedir() {
  if (_nativeOs) return _nativeOs.homedir();
  const env = _getEnv();
  return env.HOME || env.USERPROFILE || '/home/user';
}
homedir[Symbol.toPrimitive] = () => homedir();

/**
 * System uptime in seconds. Browsers approximate seconds since page load
 * via `performance.now()` (floored, matching the historical shim).
 */
export function uptime() {
  if (_nativeOs) return _nativeOs.uptime();
  return typeof performance !== 'undefined'
    ? Math.floor(performance.now() / 1000)
    : 0;
}
uptime[Symbol.toPrimitive] = () => uptime();

/** 1/5/15-minute load averages. `[0, 0, 0]` where unavailable (browsers). */
export function loadavg() {
  if (_nativeOs) return _nativeOs.loadavg();
  return [0, 0, 0];
}

/** Free system memory in bytes (2 GiB stub where unavailable). */
export function freemem() {
  if (_nativeOs) return _nativeOs.freemem();
  return 2 * 1024 * 1024 * 1024;
}
freemem[Symbol.toPrimitive] = () => freemem();

/**
 * Total system memory in bytes. Uses `navigator.deviceMemory` (GiB) where
 * available, otherwise a 4 GiB stub.
 */
export function totalmem() {
  if (_nativeOs) return _nativeOs.totalmem();
  const gb =
    typeof navigator !== 'undefined' && typeof navigator.deviceMemory === 'number'
      ? navigator.deviceMemory
      : 4;
  return gb * 1024 * 1024 * 1024;
}
totalmem[Symbol.toPrimitive] = () => totalmem();

/**
 * Estimate of usable parallelism. Uses `navigator.hardwareConcurrency`
 * where available (falling back to 1).
 */
export function availableParallelism() {
  if (_nativeOs) return _nativeOs.availableParallelism();
  return (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
}
availableParallelism[Symbol.toPrimitive] = () => availableParallelism();

/**
 * Per-logical-core info. `times` fields are `0` where CPU accounting is
 * unavailable (browsers).
 */
export function cpus() {
  if (_nativeOs) return _nativeOs.cpus();
  const count = availableParallelism();
  const stub = {
    model: 'Unknown',
    speed: 0,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  };
  return Array.from(
    { length: count },
    () => ({ ...stub, times: { ...stub.times } }),
  );
}

/**
 * Network interfaces. Browsers return a loopback-only stub matching Node's
 * shape (including `cidr`; no `scopeid` on IPv4 entries).
 */
export function networkInterfaces() {
  if (_nativeOs) return _nativeOs.networkInterfaces();
  return {
    lo: [
      {
        address: '127.0.0.1',
        netmask: '255.0.0.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: true,
        cidr: '127.0.0.1/8',
      },
      {
        address: '::1',
        netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
        family: 'IPv6',
        mac: '00:00:00:00:00:00',
        internal: true,
        cidr: '::1/128',
        scopeid: 0,
      },
    ],
  };
}

/**
 * Scheduling priority for `pid` (default 0 = current process).
 * Argument validation is ported exactly; the syscall itself delegates to
 * the native binding under Node and is a no-op stub (returning 0) in
 * browsers.
 */
export function getPriority(pid) {
  if (pid === undefined) pid = 0;
  else validateInt32(pid, 'pid');
  if (_nativeOs) return _nativeOs.getPriority(pid);
  return 0;
}

/**
 * Set scheduling priority. No-op where the OS is unreachable (browsers).
 */
export function setPriority(pid, priority) {
  if (priority === undefined) {
    priority = pid;
    pid = 0;
  }
  validateInt32(pid, 'pid');
  validateInt32(priority, 'priority', -20, 19);
  if (_nativeOs) _nativeOs.setPriority(pid, priority);
}

/** OS name as `uname(3)` would report it. */
export function type() {
  return _nativeOs ? _nativeOs.type() : _inferType();
}
type[Symbol.toPrimitive] = () => type();

/** OS release string. */
export function release() {
  return _nativeOs ? _nativeOs.release() : _inferRelease();
}
release[Symbol.toPrimitive] = () => release();

/** Kernel version string. */
export function version() {
  return _nativeOs ? _nativeOs.version() : '#1 SMP';
}
version[Symbol.toPrimitive] = () => version();

/** Machine type as `uname -m` would report it. */
export function machine() {
  return _nativeOs ? _nativeOs.machine() : _inferMachine();
}
machine[Symbol.toPrimitive] = () => machine();

/**
 * Effective-user info. Under Node this delegates to the real binding
 * (including `encoding: 'buffer'` support). The browser fallback returns
 * a stub (`uid`/`gid` `-1`, like Node on Windows); `options.encoding`
 * is still read so throwing getters propagate exactly like the native
 * binding (nodejs/node#12370).
 */
export function userInfo(options) {
  if (typeof options !== 'object') options = null;
  if (_nativeOs) return _nativeOs.userInfo(options);
  if (options !== null) void options.encoding;
  return {
    username: 'user',
    uid: -1,
    gid: -1,
    shell: null,
    homedir: homedir(),
  };
}

// ---------------------------------------------------------------------------
// Default export — mirrors Node's `module.exports` shape, including the
// exact property descriptors Node uses (`EOL`/`devNull`: configurable,
// non-writable; `constants`: non-configurable).
// ---------------------------------------------------------------------------

const os = {
  arch,
  availableParallelism,
  cpus,
  endianness,
  freemem,
  getPriority,
  homedir,
  hostname,
  loadavg,
  machine,
  networkInterfaces,
  platform,
  release,
  setPriority,
  tmpdir,
  totalmem,
  type,
  uptime,
  userInfo,
  version,
};

Object.defineProperties(os, {
  constants: {
    configurable: false,
    enumerable: true,
    value: constants,
  },
  EOL: {
    configurable: true,
    enumerable: true,
    writable: false,
    value: _EOL,
  },
  devNull: {
    configurable: true,
    enumerable: true,
    writable: false,
    value: _devNull,
  },
});

export default os;
