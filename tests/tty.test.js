// tests/tty.test.js — repo tests for src/tty.js.
//
// Every assertion below was verified against real node:tty on Node v24.20.0
// before being encoded here (see the differential script used during
// development). Two intentional browser differences are documented inline:
//   1. isTTY is always false / isatty() is always false in the browser (no OS
//      TTY handles exist there).
//   2. setRawMode() never fails in the browser (no handle to reject it);
//      real Node emits an ENOTTY 'error' on non-TTY fds.
//   3. columns/rows fall back to 80x24 (no handle to query).
// Also verified: setRawMode() does NOT validate its argument in real Node
// (it coerces with `!!`), despite what one might expect.

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import realTty from 'node:tty';

import tty, { isatty, ReadStream, WriteStream } from '../src/tty.js';

// Capture everything a WriteStream emits via write().
function capturing(fd = 1) {
  const w = new WriteStream(fd);
  const chunks = [];
  w.write = (chunk, enc, cb) => {
    if (typeof enc === 'function') cb = enc;
    chunks.push(Buffer.from(chunk).toString('utf8'));
    if (typeof cb === 'function') process.nextTick(cb);
    return true;
  };
  return { w, chunks };
}

describe('tty surface', () => {
  test('named exports', () => {
    expect(typeof isatty).toBe('function');
    expect(typeof ReadStream).toBe('function');
    expect(typeof WriteStream).toBe('function');
  });

  test('default export mirrors { isatty, ReadStream, WriteStream }', () => {
    expect(Object.keys(tty).sort()).toEqual(['ReadStream', 'WriteStream', 'isatty']);
    expect(tty.isatty).toBe(isatty);
    expect(tty.ReadStream).toBe(ReadStream);
    expect(tty.WriteStream).toBe(WriteStream);
  });

  test('no top-level getColorDepth/hasColors (they live on WriteStream.prototype)', () => {
    expect(tty.getColorDepth).toBeUndefined();
    expect(tty.hasColors).toBeUndefined();
    expect(typeof WriteStream.prototype.getColorDepth).toBe('function');
    expect(typeof WriteStream.prototype.hasColors).toBe('function');
  });

  test('WriteStream.prototype.isTTY is false (honest browser value; Node uses true)', () => {
    expect(WriteStream.prototype.isTTY).toBe(false);
  });
});

describe('isatty()', () => {
  test.each([-1, -100, 1.5, 'x', '', NaN, null, undefined, true, {}, 2 ** 31, 2 ** 40])(
    'isatty(%p) is false and never throws',
    (fd) => {
      expect(() => isatty(fd)).not.toThrow();
      expect(isatty(fd)).toBe(false);
    },
  );

  test('matches real node:tty on non-TTY inputs', () => {
    for (const fd of [-1, 1.5, 'x', NaN, null, undefined, 2 ** 31]) {
      expect(isatty(fd)).toBe(realTty.isatty(fd));
    }
  });
});

describe('constructor fd validation', () => {
  const badFds = [
    [-1, '"fd" must be a positive integer: -1'],
    [1.5, '"fd" must be a positive integer: 1.5'],
    ['1', '"fd" must be a positive integer: 1'],
    [NaN, '"fd" must be a positive integer: NaN'],
    [undefined, '"fd" must be a positive integer: undefined'],
    [1e21, '"fd" must be a positive integer: 1e+21'],
  ];

  test.each(badFds)('new WriteStream(%p) throws ERR_INVALID_FD', (fd, message) => {
    let err;
    try {
      new WriteStream(fd);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RangeError);
    expect(err.code).toBe('ERR_INVALID_FD');
    expect(err.name).toBe('RangeError');
    expect(err.message).toBe(message);
    expect(String(err)).toBe(`RangeError [ERR_INVALID_FD]: ${message}`);
  });

  test.each(badFds)('new ReadStream(%p) throws ERR_INVALID_FD', (fd, message) => {
    let err;
    try {
      new ReadStream(fd);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RangeError);
    expect(err.code).toBe('ERR_INVALID_FD');
    expect(err.message).toBe(message);
  });

  test('invalid fd without new also throws', () => {
    expect(() => WriteStream(-1)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_FD' }));
    expect(() => ReadStream(-1)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_FD' }));
  });

  test('closed/invalid non-negative fd throws ERR_TTY_INIT_FAILED (real Node parity)', () => {
    // Uses the real fs as environment feature-detection; in the browser this
    // probe is unavailable and no error is thrown (no OS fds exist there).
    let err;
    try {
      new WriteStream(1 << 30);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('ERR_TTY_INIT_FAILED');
    expect(err.name).toBe('SystemError');
    expect(err.message).toBe(
      'TTY initialization failed: uv_tty_init returned EINVAL (invalid argument)',
    );
    expect(err.info).toEqual({
      errno: -22,
      code: 'EINVAL',
      message: 'invalid argument',
      syscall: 'uv_tty_init',
    });
    expect(err.errno).toBe(-22);
    expect(err.syscall).toBe('uv_tty_init');
    expect(() => new ReadStream(1 << 30)).toThrow(
      expect.objectContaining({ code: 'ERR_TTY_INIT_FAILED' }),
    );
  });

  test('callable without new', () => {
    const w = WriteStream(1);
    expect(w).toBeInstanceOf(WriteStream);
    const r = ReadStream(0);
    expect(r).toBeInstanceOf(ReadStream);
    w.destroy();
    r.destroy();
  });
});

describe('ReadStream', () => {
  test('starts non-raw and non-TTY', () => {
    const r = new ReadStream(0);
    expect(r.isRaw).toBe(false);
    expect(r.isTTY).toBe(false);
    r.destroy();
  });

  test.each([
    [true, true],
    [false, false],
    [1, true],
    [0, false],
    ['x', true],
    ['', false],
    [undefined, false],
    [null, false],
    [{}, true],
    [NaN, false],
  ])('setRawMode(%p) coerces with !! and returns this (no validation, like Node)', (flag, expected) => {
    const r = new ReadStream(0);
    const ret = r.setRawMode(flag);
    expect(ret).toBe(r);
    expect(r.isRaw).toBe(expected);
    r.destroy();
  });
});

describe('WriteStream basics', () => {
  test('isTTY false, 80x24 fallback size', () => {
    const w = new WriteStream(1);
    expect(w.isTTY).toBe(false);
    expect(w.columns).toBe(80);
    expect(w.rows).toBe(24);
    expect(w.getWindowSize()).toEqual([80, 24]);
    w.destroy();
  });

  test('_refreshSize exists and is a safe noop', () => {
    const w = new WriteStream(1);
    expect(() => w._refreshSize()).not.toThrow();
    expect(w.getWindowSize()).toEqual([80, 24]);
    w.destroy();
  });
});

describe('ANSI cursor methods (delegate to readline, like Node)', () => {
  test('cursorTo writes \\x1b[{y+1};{x+1}H', () => {
    const { w, chunks } = capturing();
    expect(w.cursorTo(1, 2)).toBe(true);
    expect(chunks).toEqual(['\x1b[3;2H']);
    w.destroy();
  });

  test('cursorTo without y writes \\x1b[{x+1}G', () => {
    const { w, chunks } = capturing();
    w.cursorTo(4);
    expect(chunks).toEqual(['\x1b[5G']);
    w.destroy();
  });

  test('moveCursor writes relative sequences', () => {
    const { w, chunks } = capturing();
    w.moveCursor(3, -2);
    expect(chunks).toEqual(['\x1b[3C\x1b[2A']);
    w.destroy();
  });

  test('moveCursor(0,0) writes nothing but returns true', () => {
    const { w, chunks } = capturing();
    expect(w.moveCursor(0, 0)).toBe(true);
    expect(chunks).toEqual([]);
    w.destroy();
  });

  test.each([
    [0, '\x1b[2K'],
    [1, '\x1b[0K'],
    [-1, '\x1b[1K'],
  ])('clearLine(%i) writes %p', (dir, seq) => {
    const { w, chunks } = capturing();
    expect(w.clearLine(dir)).toBe(true);
    expect(chunks).toEqual([seq]);
    w.destroy();
  });

  test('clearScreenDown writes \\x1b[0J', () => {
    const { w, chunks } = capturing();
    expect(w.clearScreenDown()).toBe(true);
    expect(chunks).toEqual(['\x1b[0J']);
    w.destroy();
  });

  test('callbacks are invoked', async () => {
    const { w, chunks } = capturing();
    await new Promise((resolve) => w.cursorTo(1, 2, resolve));
    await new Promise((resolve) => w.moveCursor(1, 1, resolve));
    await new Promise((resolve) => w.clearLine(0, resolve));
    await new Promise((resolve) => w.clearScreenDown(resolve));
    expect(chunks).toHaveLength(4);
    w.destroy();
  });

  test('cursorTo(NaN) throws ERR_INVALID_ARG_VALUE', () => {
    const { w } = capturing();
    expect(() => w.cursorTo(NaN)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }),
    );
    expect(() => w.cursorTo(1, NaN)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }),
    );
    w.destroy();
  });

  test('non-function callback throws ERR_INVALID_ARG_TYPE', () => {
    const { w } = capturing();
    let err;
    try {
      w.cursorTo(1, 2, 'x');
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('ERR_INVALID_ARG_TYPE');
    expect(err.message).toBe(
      'The "callback" argument must be of type function. Received type string (\'x\')',
    );
    w.destroy();
  });

  test('byte output matches real node:tty + node:readline', () => {
    const real = new realTty.WriteStream(1);
    const realChunks = [];
    real.write = (chunk, enc, cb) => {
      if (typeof enc === 'function') cb = enc;
      realChunks.push(Buffer.from(chunk).toString('utf8'));
      return true;
    };
    const { w, chunks } = capturing();
    const calls = [
      (s) => s.cursorTo(1, 2),
      (s) => s.cursorTo(0),
      (s) => s.moveCursor(3, -2),
      (s) => s.moveCursor(-4, 7),
      (s) => s.clearLine(0),
      (s) => s.clearLine(1),
      (s) => s.clearLine(-1),
      (s) => s.clearScreenDown(),
    ];
    for (const call of calls) {
      realChunks.length = 0;
      chunks.length = 0;
      call(real);
      call(w);
      expect(chunks).toEqual(realChunks);
    }
    real.destroy();
    w.destroy();
  });
});

describe('getColorDepth()', () => {
  const w = () => new WriteStream(1);
  const cases = [
    [{}, 1],
    [{ FORCE_COLOR: '1' }, 4],
    [{ FORCE_COLOR: '' }, 4],
    [{ FORCE_COLOR: 'true' }, 4],
    [{ FORCE_COLOR: '2' }, 8],
    [{ FORCE_COLOR: '3' }, 24],
    [{ FORCE_COLOR: '0' }, 1],
    [{ FORCE_COLOR: 'banana' }, 1],
    [{ NODE_DISABLE_COLORS: '1' }, 1],
    [{ NO_COLOR: '1' }, 1],
    [{ TERM: 'dumb' }, 1],
    [{ TERM: 'xterm-256color' }, 8],
    [{ TERM: 'xterm' }, 4],
    [{ TERM: 'screen' }, 4],
    [{ TERM: 'rxvt-unicode' }, 4],
    [{ TERM: 'linux' }, 4],
    [{ TERM: 'ansi' }, 4],
    [{ TERM: 'vt100' }, 4],
    [{ TERM: 'putty' }, 4],
    [{ TERM: 'mosh' }, 24],
    [{ TERM: 'xterm-kitty' }, 24],
    [{ TERM: 'XTERM-KITTY' }, 24],
    [{ TERM: 'xterm-truecolor' }, 24],
    [{ COLORTERM: 'truecolor' }, 24],
    [{ COLORTERM: '24bit' }, 24],
    [{ COLORTERM: '1' }, 4],
    [{ TERM_PROGRAM: 'iTerm.app' }, 8],
    [{ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '2.9' }, 8],
    [{ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.4' }, 24],
    [{ TERM_PROGRAM: 'HyperTerm' }, 24],
    [{ TERM_PROGRAM: 'Apple_Terminal' }, 8],
    [{ TMUX: '1' }, 24],
    [{ CI: 'true' }, 1],
    [{ CI: 'true', GITHUB_ACTIONS: 'true' }, 24],
    [{ CI: 'true', TRAVIS: '1' }, 8],
    [{ CI: 'true', CI_NAME: 'codeship' }, 8],
    [{ TF_BUILD: '1', AGENT_NAME: 'x' }, 4],
    [{ TEAMCITY_VERSION: '9.1.1' }, 4],
    [{ TEAMCITY_VERSION: '10.0' }, 4],
    [{ TEAMCITY_VERSION: '8.0' }, 1],
  ];

  test.each(cases)('getColorDepth(%p) === %i', (env, expected) => {
    const s = w();
    expect(s.getColorDepth({ ...env })).toBe(expected);
    // and it matches real node:tty exactly
    const r = new realTty.WriteStream(1);
    expect(s.getColorDepth({ ...env })).toBe(r.getColorDepth({ ...env }));
    s.destroy();
    r.destroy();
  });

  test('null env throws TypeError like Node', () => {
    const s = w();
    expect(() => s.getColorDepth(null)).toThrow(TypeError);
    s.destroy();
  });
});

describe('hasColors()', () => {
  const w = () => new WriteStream(1);

  test.each([
    [16, {}, false], // empty env -> depth 1 -> 16 > 2
    [16, { TERM: 'xterm-256color' }, true],
    [256, { TERM: 'xterm-256color' }, true],
    [257, { TERM: 'xterm-256color' }, false],
    [16777216, { FORCE_COLOR: '3' }, true],
    [16777217, { FORCE_COLOR: '3' }, false],
  ])('hasColors(%i, %p) === %p', (count, env, expected) => {
    const s = w();
    expect(s.hasColors(count, { ...env })).toBe(expected);
    const r = new realTty.WriteStream(1);
    expect(s.hasColors(count, { ...env })).toBe(r.hasColors(count, { ...env }));
    s.destroy();
    r.destroy();
  });

  test('env-shifting forms', () => {
    const s = w();
    const r = new realTty.WriteStream(1);
    expect(s.hasColors()).toBe(r.hasColors());
    expect(s.hasColors({})).toBe(r.hasColors({}));
    expect(s.hasColors({ TERM: 'xterm-256color' })).toBe(r.hasColors({ TERM: 'xterm-256color' }));
    s.destroy();
    r.destroy();
  });

  test.each([
    [1, 'ERR_OUT_OF_RANGE', 'The value of "count" is out of range. It must be >= 2 && <= 9007199254740991. Received 1'],
    [1.5, 'ERR_OUT_OF_RANGE', 'The value of "count" is out of range. It must be an integer. Received 1.5'],
    ['x', 'ERR_INVALID_ARG_TYPE', 'The "count" argument must be of type number. Received type string (\'x\')'],
    [true, 'ERR_INVALID_ARG_TYPE', 'The "count" argument must be of type number. Received type boolean (true)'],
    [null, 'ERR_INVALID_ARG_TYPE', 'The "count" argument must be of type number. Received null'],
    [2 ** 53, 'ERR_OUT_OF_RANGE', 'The value of "count" is out of range. It must be >= 2 && <= 9007199254740991. Received 9_007_199_254_740_992'],
  ])('hasColors(%p) throws %s', (count, code, message) => {
    const s = w();
    let err;
    try {
      s.hasColors(count);
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(code);
    expect(err.message).toBe(message);
    // identical to real Node
    let realErr;
    const r = new realTty.WriteStream(1);
    try {
      r.hasColors(count);
    } catch (e) {
      realErr = e;
    }
    expect(err.message).toBe(realErr.message);
    expect(err.constructor.name).toBe(realErr.constructor.name);
    s.destroy();
    r.destroy();
  });
});

// Browser fallback lane: hide process.getBuiltinModule (the native-delegation
// path) for the whole block and prove the shim works with zero native
// delegation. The stub must be active at call time, not just import time,
// because the native probes run lazily inside the methods.
let fb;
let realGbm;
beforeAll(async () => {
  fb = (await import('../src/tty.js?fallback=tty')).default;
});

describe('tty browser fallback (no native delegation)', () => {
  beforeEach(() => {
    realGbm = process.getBuiltinModule;
    process.getBuiltinModule = undefined;
  });
  afterEach(() => {
    process.getBuiltinModule = realGbm;
  });
  test('module loads and constructs streams', () => {
    expect(typeof fb.isatty).toBe('function');
    const w = new fb.WriteStream(1);
    expect(w.isTTY).toBe(false);
    expect(w.getWindowSize()).toEqual([80, 24]);
    const r = new fb.ReadStream(0);
    expect(r.setRawMode(true).isRaw).toBe(true);
    w.destroy();
    r.destroy();
  });

  test('isatty() is always false', () => {
    for (const fd of [0, 1, 2, -1, 'x']) expect(fb.isatty(fd)).toBe(false);
  });

  test('fd validation still throws without natives', () => {
    expect(() => new fb.WriteStream(-1)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_FD' }),
    );
  });

  test('bad fd does not throw without the native probe (no OS fds in browser)', () => {
    const w = new fb.WriteStream(1 << 30);
    expect(w.isTTY).toBe(false);
    w.destroy();
  });

  test('ANSI methods still write correct escape bytes', () => {
    const w = new fb.WriteStream(1);
    const chunks = [];
    w.write = (chunk, enc, cb) => {
      if (typeof enc === 'function') cb = enc;
      chunks.push(Buffer.from(chunk).toString('utf8'));
      return true;
    };
    w.cursorTo(1, 2);
    w.clearLine(0);
    w.clearScreenDown();
    expect(chunks).toEqual(['\x1b[3;2H', '\x1b[2K', '\x1b[0J']);
    w.destroy();
  });

  test('honest platform color values', () => {
    const w = new fb.WriteStream(1);
    expect(w.getColorDepth({})).toBe(1);
    expect(w.hasColors()).toBe(false);
    w.destroy();
  });
});
