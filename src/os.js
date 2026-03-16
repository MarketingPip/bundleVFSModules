// npm install os-browserify

/*!
 * os-web — node:os for browsers & bundlers
 * MIT License.
 * Node.js parity: node:os @ Node 0.3.3+ (availableParallelism: v19.4.0)
 * Dependencies: none (uses navigator / performance globals)
 * Limitations:
 *   - arch(), platform(), type(), release(), version(), machine() are
 *     heuristic — derived from navigator.userAgent / navigator.platform.
 *   - freemem() / totalmem() return plausible constants; no real memory info.
 *   - loadavg() always returns [0, 0, 0] (POSIX-only concept).
 *   - cpus() returns a stub array sized from navigator.hardwareConcurrency.
 *   - networkInterfaces() returns a loopback-only stub.
 *   - uptime() counts seconds since page load via performance.now().
 *   - userInfo() returns a plausible stub; uid/gid are -1 (same as Windows).
 *   - getPriority() / setPriority() are no-ops returning 0.
 *   - constants.errno is empty — errno values are OS/libuv-internal.
 *   - devNull is always '/dev/null'; win32 path (\\\\.\\nul) not detected.
 *   - EOL is always '\n'; '\r\n' not inferred for Windows browsers.
 */

/**
 * @packageDocumentation
 * Browser-compatible implementation of `node:os`.
 * All functions are exported as named exports and collected on the default
 * export, matching Node's module shape exactly.
 *
 * Environment detection uses `navigator` and `performance` globals — never
 * `typeof window` — so the shim works in Web Workers and edge runtimes too.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Cached UA string (lower-cased) used by multiple detectors.
 * @type {string}
 */
const _ua =
  typeof navigator !== 'undefined'
    ? (navigator.userAgent || '').toLowerCase()
    : '';

/**
 * Cached navigator.platform (lower-cased).
 * @type {string}
 */
const _nplatform =
  typeof navigator !== 'undefined'
    ? (navigator.platform || '').toLowerCase()
    : '';

/**
 * Infer a Node-style `process.platform` value from UA / navigator.platform.
 * @returns {'win32'|'darwin'|'linux'}
 */
function _inferPlatform() {
  if (_nplatform.startsWith('win') || _ua.includes('windows')) return 'win32';
  if (_nplatform.startsWith('mac') || _ua.includes('mac os'))  return 'darwin';
  return 'linux';
}

/**
 * Infer a Node-style `process.arch` value from the UA string.
 * @returns {string}
 */
function _inferArch() {
  if (_ua.includes('aarch64') || _ua.includes('arm64'))          return 'arm64';
  if (_ua.includes('armv') || (_ua.includes('arm') && !_ua.includes('arm64'))) return 'arm';
  if (_ua.includes('x86_64') || _ua.includes('win64') ||
      _ua.includes('amd64'))                                      return 'x64';
  if (_ua.includes('i686') || _ua.includes('i386') ||
      _ua.includes('x86'))                                        return 'ia32';
  return 'x64'; // safe fallback
}

/**
 * Map platform → uname-style type string (matches Node os.type() output).
 * @returns {string}
 */
function _inferType() {
  const p = _inferPlatform();
  if (p === 'win32')  return 'Windows_NT';
  if (p === 'darwin') return 'Darwin';
  return 'Linux';
}

/**
 * Map platform → uname-style machine string (matches Node os.machine() output).
 * @returns {string}
 */
function _inferMachine() {
  const a = _inferArch();
  // Approximate uname -m output for common arches
  const map = { x64: 'x86_64', ia32: 'i686', arm64: 'aarch64', arm: 'armv7l' };
  return map[a] || a;
}

// ---------------------------------------------------------------------------
// EOL / devNull — platform-varying constants
// ---------------------------------------------------------------------------

/**
 * Operating-system-specific end-of-line marker.
 * `'\r\n'` on Windows, `'\n'` everywhere else.
 * @type {string}
 */
export const EOL = _inferPlatform() === 'win32' ? '\r\n' : '\n';

/**
 * Platform-specific path of the null device.
 * `'\\.\nul'` on Windows, `'/dev/null'` on POSIX.
 * @type {string}
 */
export const devNull = _inferPlatform() === 'win32' ? '\\\\.\\nul' : '/dev/null';

// ---------------------------------------------------------------------------
// os.arch()
// ---------------------------------------------------------------------------

/**
 * Returns the CPU architecture for which the JS engine was compiled/running.
 * Heuristic — derived from `navigator.userAgent`.
 * Possible values mirror Node: `'arm'`, `'arm64'`, `'ia32'`, `'x64'`.
 * @returns {string}
 */
export function arch() {
  return _inferArch();
}

// ---------------------------------------------------------------------------
// os.platform()
// ---------------------------------------------------------------------------

/**
 * Returns a string identifying the operating system platform.
 * Mirrors Node's `process.platform`. Heuristic.
 * @returns {'win32'|'darwin'|'linux'}
 */
export function platform() {
  return _inferPlatform();
}

// ---------------------------------------------------------------------------
// os.type()
// ---------------------------------------------------------------------------

/**
 * Returns the operating system name as `uname(3)` would return it.
 * e.g. `'Linux'`, `'Darwin'`, `'Windows_NT'`. Heuristic.
 * @returns {string}
 */
export function type() {
  return _inferType();
}

// ---------------------------------------------------------------------------
// os.release()
// ---------------------------------------------------------------------------

/**
 * Returns the operating system release string.
 * In browsers this is approximated from `navigator.appVersion`.
 * @returns {string}
 */
export function release() {
  return typeof navigator !== 'undefined' ? (navigator.appVersion || '') : '';
}

// ---------------------------------------------------------------------------
// os.version()
// ---------------------------------------------------------------------------

/**
 * Returns a string identifying the kernel version.
 * Not available in browsers — returns a stub `'#1 SMP'`.
 * @returns {string}
 */
export function version() {
  return '#1 SMP';
}

// ---------------------------------------------------------------------------
// os.machine()
// ---------------------------------------------------------------------------

/**
 * Returns the machine type as `uname -m` would return it.
 * e.g. `'x86_64'`, `'aarch64'`, `'armv7l'`. Heuristic.
 * Added: Node v18.9.0.
 * @returns {string}
 */
export function machine() {
  return _inferMachine();
}

// ---------------------------------------------------------------------------
// os.endianness()
// ---------------------------------------------------------------------------

/**
 * Determines CPU endianness at module evaluation time using a typed array.
 * Returns `'BE'` or `'LE'` — matches Node exactly (not a heuristic).
 * @returns {'BE'|'LE'}
 */
export function endianness() {
  return _kEndianness;
}

const _kEndianness = (() => {
  const buf = new ArrayBuffer(2);
  new Uint16Array(buf)[0] = 0x0102;
  return new Uint8Array(buf)[0] === 0x01 ? 'BE' : 'LE';
})();

// ---------------------------------------------------------------------------
// os.hostname()
// ---------------------------------------------------------------------------

/**
 * Returns the hostname of the machine.
 * In browsers, falls back to `location.hostname` or `'localhost'`.
 * @returns {string}
 */
export function hostname() {
  return typeof location !== 'undefined' ? (location.hostname || 'localhost') : 'localhost';
}

// ---------------------------------------------------------------------------
// os.uptime()
// ---------------------------------------------------------------------------

/**
 * Returns system uptime in seconds.
 * In browsers, approximated as seconds since page load via `performance.now()`.
 * @returns {number}
 */
export function uptime() {
  return typeof performance !== 'undefined'
    ? Math.floor(performance.now() / 1000)
    : 0;
}

// ---------------------------------------------------------------------------
// os.loadavg()
// ---------------------------------------------------------------------------

/**
 * Returns the 1, 5, and 15 minute load averages.
 * Always `[0, 0, 0]` in browsers — load average is a POSIX-only concept.
 * @returns {[number, number, number]}
 */
export function loadavg() {
  return [0, 0, 0];
}

// ---------------------------------------------------------------------------
// os.freemem() / os.totalmem()
// ---------------------------------------------------------------------------

/**
 * Returns free system memory in bytes.
 * Not available in browsers — returns a plausible 2 GiB stub.
 * @returns {number}
 */
export function freemem() {
  return 2 * 1024 * 1024 * 1024;
}

/**
 * Returns total system memory in bytes.
 * Uses `navigator.deviceMemory` (GiB, if available) or falls back to 4 GiB.
 * @returns {number}
 */
export function totalmem() {
  const gb =
    typeof navigator !== 'undefined' && typeof navigator.deviceMemory === 'number'
      ? navigator.deviceMemory
      : 4;
  return gb * 1024 * 1024 * 1024;
}

// ---------------------------------------------------------------------------
// os.availableParallelism()
// ---------------------------------------------------------------------------

/**
 * Returns an estimate of the default amount of parallelism a program should
 * use. Uses `navigator.hardwareConcurrency`, falling back to 1.
 * Added: Node v19.4.0.
 * @returns {number}
 */
export function availableParallelism() {
  return (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
}

// ---------------------------------------------------------------------------
// os.cpus()
// ---------------------------------------------------------------------------

/**
 * Returns an array of objects describing each logical CPU core.
 * In browsers, count comes from `navigator.hardwareConcurrency`.
 * All `times` fields are `0` — CPU accounting is not available.
 * @returns {Array<{model:string,speed:number,times:{user:number,nice:number,sys:number,idle:number,irq:number}}>}
 */
export function cpus() {
  const count = availableParallelism();
  const stub = {
    model: 'Unknown',
    speed: 0,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  };
  return Array.from({ length: count }, () => ({ ...stub, times: { ...stub.times } }));
}

// ---------------------------------------------------------------------------
// os.networkInterfaces()
// ---------------------------------------------------------------------------

/**
 * Returns an object describing network interfaces.
 * Not available in browsers — returns a loopback-only stub, matching Node's
 * shape including `cidr` and the absence of `scopeid` on IPv4.
 * @returns {Record<string, Array<{address:string,netmask:string,family:string,mac:string,internal:boolean,cidr:string|null,scopeid?:number}>>}
 */
export function networkInterfaces() {
  return {
    lo: [
      {
        address:  '127.0.0.1',
        netmask:  '255.0.0.0',
        family:   'IPv4',
        mac:      '00:00:00:00:00:00',
        internal: true,
        cidr:     '127.0.0.1/8',
      },
      {
        address:  '::1',
        netmask:  'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
        family:   'IPv6',
        mac:      '00:00:00:00:00:00',
        internal: true,
        cidr:     '::1/128',
        scopeid:  0,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// os.tmpdir()
// ---------------------------------------------------------------------------

/**
 * Returns the default directory for temporary files.
 * Checks `TMPDIR`/`TEMP`/`TMP` on process.env when available (e.g. Bun/Deno
 * with env access), otherwise returns `'/tmp'` (POSIX) or `'C:\\Temp'` (win32).
 * @returns {string}
 */
export function tmpdir() {
  // Best-effort: process.env may be available in Bun / Deno / CF Workers
  if (typeof process !== 'undefined' && process.env) {
    const p = _inferPlatform();
    if (p === 'win32') {
      const t = process.env.TEMP || process.env.TMP ||
        ((process.env.SystemRoot || process.env.windir || 'C:\\Windows') + '\\Temp');
      // Strip trailing backslash unless it's a drive root
      return (t.length > 1 && t[t.length - 1] === '\\' && t[t.length - 2] !== ':')
        ? t.slice(0, -1) : t;
    }
    return process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  }
  return _inferPlatform() === 'win32' ? 'C:\\Temp' : '/tmp';
}

// ---------------------------------------------------------------------------
// os.homedir()
// ---------------------------------------------------------------------------

/**
 * Returns the current user's home directory path.
 * Checks `process.env.HOME` / `USERPROFILE` when available.
 * @returns {string}
 */
export function homedir() {
  if (typeof process !== 'undefined' && process.env) {
    return process.env.HOME || process.env.USERPROFILE || '/home/user';
  }
  return '/home/user';
}

// ---------------------------------------------------------------------------
// os.userInfo()
// ---------------------------------------------------------------------------

/**
 * @typedef {{ username:string, uid:number, gid:number, shell:string|null, homedir:string }} UserInfo
 */

/**
 * Returns information about the currently effective user.
 * uid and gid are `-1` in browsers (same as Node on Windows).
 * `encoding: 'buffer'` is accepted but ignored — always returns strings.
 * @param {{ encoding?: string }} [options]
 * @returns {UserInfo}
 */
export function userInfo(options) { // eslint-disable-line no-unused-vars
  return {
    username: 'user',
    uid:      -1,
    gid:      -1,
    shell:    null,
    homedir:  homedir(),
  };
}

// ---------------------------------------------------------------------------
// os.getPriority() / os.setPriority()
// ---------------------------------------------------------------------------

/**
 * Returns the scheduling priority for the given pid.
 * No-op in browsers — always returns `0`.
 * @param {number} [pid=0]
 * @returns {number}
 */
export function getPriority(pid) { // eslint-disable-line no-unused-vars
  return 0;
}

/**
 * Sets the scheduling priority for the given pid.
 * No-op in browsers.
 * @param {number} pid
 * @param {number} [priority]
 * @returns {void}
 */
export function setPriority(pid, priority) {} // eslint-disable-line no-unused-vars

// ---------------------------------------------------------------------------
// os.constants
// ---------------------------------------------------------------------------

/**
 * Operating-system-specific constants.
 * `signals` and `priority` match Node's values exactly.
 * `errno` is empty — errno values are platform/libuv-internal and not
 * usefully shimmed in a browser context.
 * `dlopen` constants are omitted (not applicable in browsers).
 */
export const constants = Object.freeze({
  signals: Object.freeze({
    SIGHUP:    1,  SIGINT:   2,  SIGQUIT:  3,  SIGILL:   4,
    SIGTRAP:   5,  SIGABRT:  6,  SIGIOT:   6,  SIGBUS:   7,
    SIGFPE:    8,  SIGKILL:  9,  SIGUSR1: 10,  SIGSEGV: 11,
    SIGUSR2:  12,  SIGPIPE: 13,  SIGALRM: 14,  SIGTERM: 15,
    SIGCHLD:  17,  SIGSTKFLT: 16, SIGCONT: 18, SIGSTOP: 19,
    SIGTSTP:  20,  SIGTTIN: 21,  SIGTTOU: 22,  SIGURG:  23,
    SIGXCPU:  24,  SIGXFSZ: 25,  SIGVTALRM: 26, SIGPROF: 27,
    SIGWINCH: 28,  SIGIO:   29,  SIGPOLL: 29,  SIGPWR:  30,
    SIGINFO:  30,  SIGSYS:  31,  SIGUNUSED: 31,
  }),
  errno: Object.freeze({}),
  priority: Object.freeze({
    PRIORITY_LOW:          19,
    PRIORITY_BELOW_NORMAL: 10,
    PRIORITY_NORMAL:        0,
    PRIORITY_ABOVE_NORMAL: -7,
    PRIORITY_HIGH:        -14,
    PRIORITY_HIGHEST:     -20,
  }),
});

// ---------------------------------------------------------------------------
// Default export — mirrors Node's module.exports shape
// ---------------------------------------------------------------------------

export default {
  EOL,
  devNull,
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
  constants,
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import os from './os';
//
// os.platform()            // 'darwin' | 'win32' | 'linux'  (heuristic)
// os.arch()                // 'x64' | 'arm64' | ...         (heuristic)
// os.endianness()          // 'LE' or 'BE'                  (exact — typed array probe)
// os.type()                // 'Darwin' | 'Windows_NT' | 'Linux'
// os.machine()             // 'x86_64' | 'aarch64' | ...
// os.hostname()            // location.hostname || 'localhost'
// os.uptime()              // seconds since page load
// os.totalmem()            // navigator.deviceMemory * 1GiB  (or 4 GiB stub)
// os.freemem()             // 2 GiB stub
// os.availableParallelism()// navigator.hardwareConcurrency || 1
// os.cpus().length         // same as availableParallelism()
// os.loadavg()             // [0, 0, 0]
// os.networkInterfaces()   // { lo: [ IPv4 stub, IPv6 stub ] }
// os.tmpdir()              // '/tmp' (or TMPDIR env if available)
// os.homedir()             // '/home/user' (or HOME env if available)
// os.userInfo()            // { username:'user', uid:-1, gid:-1, shell:null, homedir:'/home/user' }
// os.EOL                   // '\n' (or '\r\n' on inferred win32)
// os.devNull               // '/dev/null' (or '\\.\nul' on inferred win32)
// os.constants.signals.SIGINT  // 2
// os.constants.priority.PRIORITY_HIGH  // -14
//
// // getPriority / setPriority are no-ops
// os.getPriority()         // 0
// os.setPriority(0, 10)    // no-op
//
// // Edge: deviceMemory unavailable
// // navigator.deviceMemory is undefined in Firefox → totalmem() → 4 GiB
