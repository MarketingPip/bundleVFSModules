// src/tty.js — Port of Node.js v24.20.0 lib/tty.js (plus the environment-based
// color-depth logic from lib/internal/tty.js) for the browser runtime.
//
// Browser reality: there are no OS TTY handles, so every stream is a working
// non-TTY stream (`isTTY === false`), `isatty()` is always false, and the
// window size falls back to 80x24. Everything else — fd validation, error
// codes/messages, ANSI escape output, color-depth math — matches Node exactly.
//
// The ANSI cursor methods (cursorTo/moveCursor/clearLine/clearScreenDown)
// delegate to the `readline` module exactly like Node's "Backwards-compat"
// section does. Under Node that is the real `node:readline` (a default import
// is used so host monkey-patching stays visible); in the sandbox bundle the
// import is external and rewritten to `loadModule("readline")`, i.e. this
// repo's own readline shim, which emits the same escape sequences.

import { Readable, Writable } from './stream.js';
import readline from 'readline';

// 1. Runtime bridge (guarded: rewritten to the sandbox scope at load time,
//    undefined under real Node / direct import).
const RT = (typeof globalThis._RUNTIME_ !== 'undefined')
  ? globalThis._RUNTIME_
  : undefined;

// ─── Coded errors (shapes mirror Node's internal/errors) ────────────────────

class TTYRangeError extends RangeError {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

class TTYTypeError extends TypeError {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

// Node's E() helper names the generated classes after their base (e.g.
// `err.constructor.name === 'RangeError'`); match that observable detail.
Object.defineProperty(TTYRangeError, 'name', { value: 'RangeError' });
Object.defineProperty(TTYTypeError, 'name', { value: 'TypeError' });

// Node reports tty-init failures as a SystemError carrying the uv result.
class TTYSystemError extends Error {
  constructor(message, info) {
    super(message);
    this.name = 'SystemError';
    this.code = 'ERR_TTY_INIT_FAILED';
    this.info = info;
    this.errno = info.errno;
    this.syscall = info.syscall;
  }
  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

// Real tty-init failures report `constructor.name === 'NodeError'` with
// `name === 'SystemError'`.
Object.defineProperty(TTYSystemError, 'name', { value: 'NodeError' });

function addNumericalSeparator(val) {
  let res = '';
  let i = val.length;
  const start = val[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) {
    res = `_${val.slice(i - 3, i)}${res}`;
  }
  return `${val.slice(0, i)}${res}`;
}

// Mirrors Node's determineSpecificType() for error "Received ..." rendering.
function specificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  switch (type) {
    case 'bigint':
      return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      if (value !== value) return 'type number (NaN)';
      if (value === Infinity) return 'type number (Infinity)';
      if (value === -Infinity) return 'type number (-Infinity)';
      return `type number (${value})`;
    case 'boolean':
      return `type boolean (${value})`;
    case 'symbol':
      return `type symbol (${String(value)})`;
    case 'function':
      return `function ${value.name}`;
    case 'object':
      if (value.constructor && 'name' in value.constructor) {
        return `an instance of ${value.constructor.name}`;
      }
      return String(value);
    case 'string': {
      let s = value;
      if (s.length > 28) s = `${s.slice(0, 25)}...`;
      if (!s.includes("'")) return `type string ('${s}')`;
      return `type string (${JSON.stringify(s)})`;
    }
    default:
      return String(value);
  }
}

// Mirrors internal/validators validateInteger(value, name, min, max).
function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') {
    throw new TTYTypeError(
      'ERR_INVALID_ARG_TYPE',
      `The "${name}" argument must be of type number. Received ${specificType(value)}`,
    );
  }
  if (!Number.isInteger(value)) {
    throw new TTYRangeError(
      'ERR_OUT_OF_RANGE',
      `The value of "${name}" is out of range. It must be an integer. ` +
        `Received ${formatOutOfRangeReceived(value)}`,
    );
  }
  if (value < min || value > max) {
    throw new TTYRangeError(
      'ERR_OUT_OF_RANGE',
      `The value of "${name}" is out of range. It must be >= ${min} && <= ${max}. ` +
        `Received ${formatOutOfRangeReceived(value)}`,
    );
  }
}

function formatOutOfRangeReceived(input) {
  // Node: separators only for integers with |value| > 2**32, else inspect().
  if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) {
    return addNumericalSeparator(String(input));
  }
  if (Object.is(input, -0)) return '-0';
  return String(input);
}

// ─── Environment helpers (no window/document; worker-safe) ──────────────────

function defaultEnv() {
  try {
    const rtEnv = RT && RT.process && RT.process.env;
    if (rtEnv && typeof rtEnv === 'object') return rtEnv;
  } catch { /* ignore */ }
  const gp = globalThis.process;
  if (gp && typeof gp.env === 'object' && gp.env !== null) return gp.env;
  return {};
}

function currentPlatform() {
  try {
    const rtPlatform = RT && RT.process && RT.process.platform;
    if (typeof rtPlatform === 'string') return rtPlatform;
  } catch { /* ignore */ }
  const gp = globalThis.process;
  if (gp && typeof gp.platform === 'string') return gp.platform;
  return 'browser';
}

// The real Node builtin, when we are genuinely running under Node. Used ONLY
// as environment feature-detection (is this fd a TTY / is it even open?);
// the browser path never needs it.
function nativeModule(name) {
  try {
    const p = globalThis.process;
    const gbm = p && typeof p.getBuiltinModule === 'function' ? p.getBuiltinModule : null;
    return gbm ? gbm.call(p, name) : undefined;
  } catch {
    return undefined;
  }
}

function nativeIsTTY(fd) {
  const tty = nativeModule('tty');
  if (!tty || typeof tty.isatty !== 'function') return false;
  try {
    return tty.isatty(fd) === true;
  } catch {
    return false;
  }
}

// ─── fd handling ─────────────────────────────────────────────────────────────

function validateFd(fd) {
  // Matches lib/tty.js: `if (fd >> 0 !== fd || fd < 0) throw new ERR_INVALID_FD(fd)`.
  if (fd >> 0 !== fd || fd < 0) {
    throw new TTYRangeError('ERR_INVALID_FD', `"fd" must be a positive integer: ${String(fd)}`);
  }
}

// Under real Node, opening a TTY wrapper on a closed/invalid fd fails in
// uv_tty_init. Detect that with the real fs as pure feature-detection; in the
// browser the probe is unavailable and every fd yields a working non-TTY
// stream (there are no OS fds to be invalid).
function assertTtyInitOk(fd) {
  const fs = nativeModule('fs');
  if (!fs || typeof fs.fstatSync !== 'function') return;
  let bad = false;
  try {
    fs.fstatSync(fd);
  } catch {
    bad = true;
  }
  if (!bad) return;
  const isWindows = currentPlatform() === 'win32';
  const info = isWindows
    ? { errno: -9, code: 'EBADF', message: 'bad file descriptor', syscall: 'uv_tty_init' }
    : { errno: -22, code: 'EINVAL', message: 'invalid argument', syscall: 'uv_tty_init' };
  const suffix = isWindows ? 'EBADF (bad file descriptor)' : 'EINVAL (invalid argument)';
  throw new TTYSystemError(
    `TTY initialization failed: uv_tty_init returned ${suffix}`,
    info,
  );
}

// ─── isatty ──────────────────────────────────────────────────────────────────

export function isatty(fd) {
  return Number.isInteger(fd) && fd >= 0 && fd <= 2147483647 && nativeIsTTY(fd);
}

// ─── Color depth (port of lib/internal/tty.js; pure env logic) ──────────────

const COLORS_2 = 1;
const COLORS_16 = 4;
const COLORS_256 = 8;
const COLORS_16m = 24;

// Some entries were taken from `dircolors`
// (https://linux.die.net/man/1/dircolors). The corresponding terminals might
// support more than 16 colors, but this was not tested for.
const TERM_ENVS = {
  'eterm': COLORS_16,
  'cons25': COLORS_16,
  'console': COLORS_16,
  'cygwin': COLORS_16,
  'dtterm': COLORS_16,
  'gnome': COLORS_16,
  'hurd': COLORS_16,
  'jfbterm': COLORS_16,
  'konsole': COLORS_16,
  'kterm': COLORS_16,
  'mlterm': COLORS_16,
  'mosh': COLORS_16m,
  'putty': COLORS_16,
  'st': COLORS_16,
  // http://lists.schmorp.de/pipermail/rxvt-unicode/2016q2/002261.html
  'rxvt-unicode-24bit': COLORS_16m,
  // https://bugs.launchpad.net/terminator/+bug/1030562
  'terminator': COLORS_16m,
  'xterm-kitty': COLORS_16m,
};

const CI_ENVS_MAP = new Map(Object.entries({
  APPVEYOR: COLORS_256,
  BUILDKITE: COLORS_256,
  CIRCLECI: COLORS_16m,
  DRONE: COLORS_256,
  GITEA_ACTIONS: COLORS_16m,
  GITHUB_ACTIONS: COLORS_16m,
  GITLAB_CI: COLORS_256,
  TRAVIS: COLORS_256,
}));

const TERM_ENVS_REG_EXP = [
  /ansi/,
  /color/,
  /linux/,
  /direct/,
  /^con[0-9]*x[0-9]/,
  /^rxvt/,
  /^screen/,
  /^xterm/,
  /^vt100/,
  /^vt220/,
];

let warned = false;
function warnOnDeactivatedColors(env) {
  if (warned) return;
  let name = '';
  if (env.NODE_DISABLE_COLORS !== undefined && env.NODE_DISABLE_COLORS !== '') {
    name = 'NODE_DISABLE_COLORS';
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') {
    if (name !== '') {
      name += "' and '";
    }
    name += 'NO_COLOR';
  }

  if (name !== '') {
    const p = globalThis.process;
    if (p && typeof p.emitWarning === 'function') {
      p.emitWarning(
        `The '${name}' env is ignored due to the 'FORCE_COLOR' env being set.`,
        'Warning',
      );
    }
    warned = true;
  }
}

// The `getColorDepth` API got inspired by multiple sources such as
// https://github.com/chalk/supports-color,
// https://github.com/isaacs/color-support.
function getColorDepth(env = defaultEnv()) {
  // Use level 0-3 to support the same levels as `chalk` does. This is done for
  // consistency throughout the ecosystem.
  if (env.FORCE_COLOR !== undefined) {
    switch (env.FORCE_COLOR) {
      case '':
      case '1':
      case 'true':
        warnOnDeactivatedColors(env);
        return COLORS_16;
      case '2':
        warnOnDeactivatedColors(env);
        return COLORS_256;
      case '3':
        warnOnDeactivatedColors(env);
        return COLORS_16m;
      default:
        return COLORS_2;
    }
  }

  if ((env.NODE_DISABLE_COLORS !== undefined && env.NODE_DISABLE_COLORS !== '') ||
      // See https://no-color.org/
      (env.NO_COLOR !== undefined && env.NO_COLOR !== '') ||
      // The "dumb" special terminal, as defined by terminfo, doesn't support
      // ANSI color control codes.
      // See https://invisible-island.net/ncurses/terminfo.ti.html#toc-_Specials
      env.TERM === 'dumb') {
    return COLORS_2;
  }

  if (currentPlatform() === 'win32') {
    // Best effort: without os.release() we cannot know the Windows build
    // number; fall back to the pre-10586 level like very old Windows.
    let build;
    try {
      const osMod = nativeModule('os');
      const release = osMod && typeof osMod.release === 'function' ? osMod.release() : undefined;
      const parts = typeof release === 'string' ? release.split('.', 3) : [];
      if (parts.length === 3 && +parts[0] >= 10) build = +parts[2];
    } catch { /* ignore */ }
    if (build !== undefined) {
      // Windows 10 build 14931 is the first release that supports 16m/TrueColor.
      if (build >= 14931) return COLORS_16m;
      // Windows 10 build 10586 is the first Windows release that supports 256 colors.
      if (build >= 10586) return COLORS_256;
    }
    return COLORS_16;
  }

  if (env.TMUX) {
    return COLORS_16m;
  }

  // Azure DevOps
  if (Object.prototype.hasOwnProperty.call(env, 'TF_BUILD') &&
      Object.prototype.hasOwnProperty.call(env, 'AGENT_NAME')) {
    return COLORS_16;
  }

  if (Object.prototype.hasOwnProperty.call(env, 'CI')) {
    for (const [envName, colors] of CI_ENVS_MAP) {
      if (Object.prototype.hasOwnProperty.call(env, envName)) {
        return colors;
      }
    }
    if (env.CI_NAME === 'codeship') {
      return COLORS_256;
    }
    return COLORS_2;
  }

  if ('TEAMCITY_VERSION' in env) {
    return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION) ?
      COLORS_16 : COLORS_2;
  }

  switch (env.TERM_PROGRAM) {
    case 'iTerm.app':
      if (!env.TERM_PROGRAM_VERSION ||
        /^[0-2]\./.test(env.TERM_PROGRAM_VERSION)
      ) {
        return COLORS_256;
      }
      return COLORS_16m;
    case 'HyperTerm':
    case 'MacTerm':
      return COLORS_16m;
    case 'Apple_Terminal':
      return COLORS_256;
  }

  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') {
    return COLORS_16m;
  }

  if (env.TERM) {
    if (/truecolor/.test(env.TERM)) {
      return COLORS_16m;
    }

    if (/^xterm-256/.test(env.TERM)) {
      return COLORS_256;
    }

    const termEnv = String(env.TERM).toLowerCase();

    if (TERM_ENVS[termEnv]) {
      return TERM_ENVS[termEnv];
    }
    if (TERM_ENVS_REG_EXP.some((term) => term.test(termEnv))) {
      return COLORS_16;
    }
  }
  // Move 16 color COLORTERM below 16m and 256
  if (env.COLORTERM) {
    return COLORS_16;
  }
  return COLORS_2;
}

function hasColors(count, env) {
  if (env === undefined &&
      (count === undefined || (typeof count === 'object' && count !== null))) {
    env = count;
    count = 16;
  } else {
    validateInteger(count, 'count', 2);
  }

  return count <= 2 ** getColorDepth(env);
}

// ─── ReadStream ──────────────────────────────────────────────────────────────

// Function-style constructors (like Node's lib/tty.js) so the classes remain
// callable without `new`; the real work lives in the ES classes below.

class ReadStreamImpl extends Readable {
  constructor(fd, options) {
    validateFd(fd);
    assertTtyInitOk(fd);
    super(options);
    // Browser: no OS handle to put in raw mode and no real TTY.
    this.isRaw = false;
    this.isTTY = false;
  }

  setRawMode(flag) {
    // Matches Node: truthy coercion, no argument validation, returns `this`.
    flag = !!flag;
    this.isRaw = flag;
    return this;
  }
}

export function ReadStream(fd, options) {
  return new ReadStreamImpl(fd, options);
}
Object.setPrototypeOf(ReadStream, Readable);
ReadStream.prototype = ReadStreamImpl.prototype;
ReadStream.prototype.constructor = ReadStream;
Object.defineProperty(ReadStreamImpl, 'name', { value: 'ReadStream' });

// ─── WriteStream ─────────────────────────────────────────────────────────────

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

class WriteStreamImpl extends Writable {
  constructor(fd) {
    validateFd(fd);
    assertTtyInitOk(fd);
    super();
    // Browser: no OS handle, so the window size is the honest fallback.
    this.columns = DEFAULT_COLUMNS;
    this.rows = DEFAULT_ROWS;
  }

  getColorDepth(env) {
    return getColorDepth(env);
  }

  hasColors(count, env) {
    return hasColors(count, env);
  }

  getWindowSize() {
    return [this.columns, this.rows];
  }

  _refreshSize() {
    // No OS handle to re-query in the browser; the size is fixed. Kept for
    // API compatibility (Node emits 'resize' here when the size changes).
  }

  // Backwards-compat: delegate to readline, exactly like Node.
  cursorTo(x, y, callback) {
    return readline.cursorTo(this, x, y, callback);
  }

  moveCursor(dx, dy, callback) {
    return readline.moveCursor(this, dx, dy, callback);
  }

  clearLine(dir, callback) {
    return readline.clearLine(this, dir, callback);
  }

  clearScreenDown(callback) {
    return readline.clearScreenDown(this, callback);
  }
}

export function WriteStream(fd) {
  return new WriteStreamImpl(fd);
}
Object.setPrototypeOf(WriteStream, Writable);
WriteStream.prototype = WriteStreamImpl.prototype;
WriteStream.prototype.constructor = WriteStream;
Object.defineProperty(WriteStreamImpl, 'name', { value: 'WriteStream' });

// Matches lib/tty.js (`WriteStream.prototype.isTTY = true`) — the honest
// browser value is false (no real TTY).
WriteStream.prototype.isTTY = false;

export default {
  isatty,
  ReadStream,
  WriteStream,
};
