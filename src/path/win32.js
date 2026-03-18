/*!
 * path-web/win32 — node:path/win32 for browsers & bundlers
 * MIT License.
 * Node.js parity: node:path/win32 @ Node 0.1.90+
 * Dependencies: path-browserify (via ./path)
 * Limitations:
 *   - path-browserify has no native win32 implementation; this module
 *     provides a faithful hand-written shim covering the full win32 API.
 *   - resolve() has no process.cwd() or drive-letter tracking; falls back
 *     to 'C:\\' as the implied root.
 *   - UNC paths (\\server\share) are parsed but resolve() does not
 *     preserve the UNC root across multiple arguments.
 */

/**
 * @packageDocumentation
 * Full win32 path implementation for browser environments.
 * Handles backslash separators, drive letters (C:\), UNC roots (\\server\share),
 * and all Node.js path/win32 methods.
 *
 * Consumers on non-Windows hosts use this to manipulate Windows path strings
 * (e.g. a dev tool reading Windows registry exports or build configs).
 */

// path-browserify exposes only posix; win32 must be implemented here.
// We import path solely for the fallback win32 alias it provides, but
// we override every method with correct win32 semantics below.
import path from '../path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const sep       = '\\';
export const delimiter = ';';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** @param {string} p */
function assertPath(p) {
  if (typeof p !== 'string')
    throw new TypeError('Path must be a string. Received ' + JSON.stringify(p));
}

/**
 * Returns true if the char code is a path separator (/ or \).
 * @param {number} code
 */
const isSep = code => code === 47 /* / */ || code === 92 /* \ */;

/**
 * Returns the length of the drive root at the start of `p`, or 0.
 * Handles:  C:\  C:/  \\server\share\  //server/share/  \  /
 * @param {string} p
 * @returns {number}
 */
function rootLength(p) {
  const len = p.length;
  if (!len) return 0;
  const c0 = p.charCodeAt(0);

  // UNC: \\server\share  or  //server/share
  if (isSep(c0) && len > 1 && isSep(p.charCodeAt(1))) {
    let idx = 2;
    const serverStart = idx;
    while (idx < len && !isSep(p.charCodeAt(idx))) idx++;
    if (idx === serverStart || idx >= len) return idx; // no share part
    idx++; // skip separator
    const shareStart = idx;
    while (idx < len && !isSep(p.charCodeAt(idx))) idx++;
    if (idx === shareStart) return idx;
    return idx < len ? idx + 1 : idx; // include trailing sep if present
  }

  // Drive letter: C:\ or C:/
  if (len >= 2 && p.charCodeAt(1) === 58 /* : */) {
    if (len >= 3 && isSep(p.charCodeAt(2))) return 3;
    return 2;
  }

  // Single separator
  if (isSep(c0)) return 1;
  return 0;
}

/**
 * Resolves `.` and `..` segments in a normalised path string (no root prefix).
 * @param {string} p
 * @param {boolean} allowAboveRoot
 * @returns {string}
 */
function normalizeString(p, allowAboveRoot) {
  let res = '', lastLen = 0, lastSlash = -1, dots = 0, code;
  for (let i = 0; i <= p.length; i++) {
    code = i < p.length ? p.charCodeAt(i) : 92;
    if (isSep(code)) {
      if (lastSlash === i - 1 || dots === 1) {
        // skip
      } else if (dots === 2) {
        if (res.length < 2 || lastLen !== 2 ||
            res.charCodeAt(res.length - 1) !== 46 ||
            res.charCodeAt(res.length - 2) !== 46) {
          if (res.length > 2) {
            const lsi = Math.max(res.lastIndexOf('\\'), res.lastIndexOf('/'));
            if (lsi !== res.length - 1) {
              res = lsi === -1 ? '' : res.slice(0, lsi);
              lastLen = res.length - 1 - Math.max(res.lastIndexOf('\\'), res.lastIndexOf('/'));
              lastSlash = i; dots = 0; continue;
            }
          } else if (res.length) { res = ''; lastLen = 0; lastSlash = i; dots = 0; continue; }
        }
        if (allowAboveRoot) { res = res.length ? res + '\\..' : '..'; lastLen = 2; }
      } else {
        const seg = p.slice(lastSlash + 1, i);
        res = res.length ? res + '\\' + seg : seg;
        lastLen = i - lastSlash - 1;
      }
      lastSlash = i; dots = 0;
    } else if (code === 46 && dots !== -1) {
      dots++;
    } else {
      dots = -1;
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves a sequence of paths into an absolute win32 path.
 * Falls back to `C:\` as the implied cwd (no process available in browser).
 * @param {...string} args
 * @returns {string}
 */
export function resolve(...args) {
  let resolvedDevice = '';
  let resolvedTail   = '';
  let resolvedAbs    = false;

  for (let i = args.length - 1; i >= -1; i--) {
    const p = i >= 0 ? args[i] : (resolvedDevice || 'C:') + '\\';
    assertPath(p);
    if (!p.length) continue;

    const rLen = rootLength(p);
    const device = rLen >= 2 ? p.slice(0, 2).toUpperCase() : '';
    const isAbs  = rLen > 0 && isSep(p.charCodeAt(rLen === 2 ? 2 : rLen - 1));

    if (device && resolvedDevice && device !== resolvedDevice) continue;

    if (!resolvedDevice) resolvedDevice = device;
    if (!resolvedAbs) {
      resolvedTail = p.slice(rLen) + (resolvedTail ? '\\' + resolvedTail : '');
      resolvedAbs  = isAbs;
    } else {
      resolvedTail = p.slice(rLen) + (resolvedTail ? '\\' + resolvedTail : '');
    }
    if (resolvedDevice && resolvedAbs) break;
  }

  resolvedTail = normalizeString(resolvedTail, !resolvedAbs);
  return resolvedDevice + (resolvedAbs ? '\\' : '') + (resolvedTail || '.');
}

/**
 * Normalizes a win32 path, resolving `.` / `..` and collapsing separators.
 * @param {string} p
 * @returns {string}
 */
export function normalize(p) {
  assertPath(p);
  if (!p.length) return '.';

  const rLen   = rootLength(p);
  const root   = rLen ? p.slice(0, rLen).replace(/\//g, '\\') : '';
  const isAbs  = rLen > 0 && isSep(p.charCodeAt(rLen - 1));
  let tail     = normalizeString(p.slice(rLen), !isAbs);

  if (!tail && !isAbs) tail = '.';
  if (tail && isSep(p.charCodeAt(p.length - 1))) tail += '\\';
  return root + tail;
}

/**
 * @param {string} p
 * @returns {boolean}
 */
export function isAbsolute(p) {
  assertPath(p);
  const rLen = rootLength(p);
  return rLen > 0 && (rLen > 2 || isSep(p.charCodeAt(rLen - 1)));
}

/**
 * Joins path segments with `\`, then normalizes.
 * @param {...string} args
 * @returns {string}
 */
export function join(...args) {
  if (!args.length) return '.';
  let joined;
  for (const a of args) {
    assertPath(a);
    if (a.length) joined = joined === undefined ? a : joined + '\\' + a;
  }
  return joined === undefined ? '.' : normalize(joined);
}

/**
 * Computes the relative path from `from` to `to` using win32 semantics.
 * Drive letters are compared case-insensitively.
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
export function relative(from, to) {
  assertPath(from); assertPath(to);
  if (from === to) return '';
  from = resolve(from); to = resolve(to);
  if (from.toUpperCase() === to.toUpperCase()) return '';

  const fromParts = from.split('\\').filter(Boolean);
  const toParts   = to.split('\\').filter(Boolean);

  // Skip shared drive root
  let common = 0;
  const len = Math.min(fromParts.length, toParts.length);
  while (common < len && fromParts[common].toUpperCase() === toParts[common].toUpperCase())
    common++;

  const up   = fromParts.length - common;
  const down = toParts.slice(common);
  return [...Array(up).fill('..'), ...down].join('\\') || '.';
}

/**
 * @param {string} p
 * @returns {string}
 */
export function dirname(p) {
  assertPath(p);
  if (!p.length) return '.';
  const rLen = rootLength(p);
  const root = p.slice(0, rLen);
  let end = -1, matchedSlash = true;
  for (let i = p.length - 1; i >= rLen; i--) {
    if (isSep(p.charCodeAt(i))) {
      if (!matchedSlash) { end = i; break; }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) return root || '.';
  return (root + p.slice(rLen, end)) || '.';
}

/**
 * @param {string} p
 * @param {string} [ext]
 * @returns {string}
 */
export function basename(p, ext) {
  if (ext !== undefined && typeof ext !== 'string')
    throw new TypeError('"ext" argument must be a string');
  assertPath(p);
  const rLen = rootLength(p);
  let start = rLen, end = -1, matchedSlash = true;

  for (let i = p.length - 1; i >= rLen; i--) {
    if (isSep(p.charCodeAt(i))) {
      if (!matchedSlash) { start = i + 1; break; }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  if (end === -1) return '';
  let base = p.slice(start, end);
  if (ext && base.length > ext.length &&
      base.slice(-ext.length).toLowerCase() === ext.toLowerCase())
    base = base.slice(0, base.length - ext.length);
  return base;
}

/**
 * @param {string} p
 * @returns {string}
 */
export function extname(p) {
  assertPath(p);
  const rLen = rootLength(p);
  let startDot = -1, startPart = rLen, end = -1, matchedSlash = true, preDotState = 0;
  for (let i = p.length - 1; i >= rLen; i--) {
    const c = p.charCodeAt(i);
    if (isSep(c)) { if (!matchedSlash) { startPart = i + 1; break; } continue; }
    if (end === -1) { matchedSlash = false; end = i + 1; }
    if (c === 46) { if (startDot === -1) startDot = i; else if (preDotState !== 1) preDotState = 1; }
    else if (startDot !== -1) preDotState = -1;
  }
  if (startDot === -1 || end === -1 || preDotState === 0 ||
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) return '';
  return p.slice(startDot, end);
}

/**
 * @param {{ root?:string; dir?:string; base?:string; name?:string; ext?:string }} obj
 * @returns {string}
 */
export function format(obj) {
  if (obj === null || typeof obj !== 'object')
    throw new TypeError('The "pathObject" argument must be of type Object');
  const dir  = obj.dir || obj.root;
  const base = obj.base || (obj.name || '') + (obj.ext || '');
  if (!dir) return base;
  return dir === obj.root ? dir + base : dir + '\\' + base;
}

/**
 * @param {string} p
 * @returns {{ root:string; dir:string; base:string; ext:string; name:string }}
 */
export function parse(p) {
  assertPath(p);
  const ret  = { root: '', dir: '', base: '', ext: '', name: '' };
  if (!p.length) return ret;
  const rLen = rootLength(p);
  ret.root   = p.slice(0, rLen);
  if (rLen === p.length) { ret.dir = ret.root; return ret; }

  let startDot = -1, startPart = rLen, end = -1, matchedSlash = true, preDotState = 0;
  for (let i = p.length - 1; i >= rLen; i--) {
    const c = p.charCodeAt(i);
    if (isSep(c)) { if (!matchedSlash) { startPart = i + 1; break; } continue; }
    if (end === -1) { matchedSlash = false; end = i + 1; }
    if (c === 46) { if (startDot === -1) startDot = i; else if (preDotState !== 1) preDotState = 1; }
    else if (startDot !== -1) preDotState = -1;
  }

  if (end !== -1) {
    if (startDot === -1 || preDotState === 0 ||
        (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
      ret.base = ret.name = p.slice(startPart, end);
    } else {
      ret.name = p.slice(startPart, startDot);
      ret.ext  = p.slice(startDot, end);
      ret.base = p.slice(startPart, end);
    }
  }
  const dirEnd = startPart > rLen ? startPart - 1 : rLen;
  ret.dir = dirEnd > 0 ? p.slice(0, dirEnd) : ret.root;
  return ret;
}

// Self-referential sub-objects for parity with Node's path.win32.posix / .win32
export const win32 = {
  sep, delimiter,
  resolve, normalize, isAbsolute, join, relative,
  dirname, basename, extname, format, parse,
};
win32.win32 = win32;
win32.posix = path.posix;  // forward to the POSIX impl from ./path

export const posix = path.posix;

export default win32;

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import win32, { join, resolve, parse, basename } from './path/win32';
//
// join('C:\\Users', 'foo', '..', 'bar')
// // → 'C:\Users\bar'
//
// resolve('C:\\Windows', 'System32', '..', 'Temp')
// // → 'C:\Windows\Temp'
//
// parse('C:\\Users\\alice\\file.txt')
// // → { root: 'C:\\', dir: 'C:\\Users\\alice',
// //     base: 'file.txt', ext: '.txt', name: 'file' }
//
// basename('C:\\Users\\alice\\report.pdf', '.pdf')
// // → 'report'
//
// // UNC path
// parse('\\\\server\\share\\docs\\readme.md')
// // → { root: '\\\\server\\share\\', dir: '\\\\server\\share\\docs',
// //     base: 'readme.md', ext: '.md', name: 'readme' }
//
// // Mixed separators are normalised
// normalize('C:/Users\\foo//bar\\.')
// // → 'C:\Users\foo\bar'
//
// // Case-insensitive relative()
// relative('C:\\Users\\Alice', 'C:\\users\\alice\\docs')
// // → 'docs'
//
// // Edge: drive mismatch — resolve sticks to last absolute drive
// resolve('D:\\data', 'C:\\Windows')
// // → 'C:\Windows'


/**
import {
  describe,
  test,
  expect,
  run,
} from 'https://unpkg.com/@live-codes/browser-jest';

// adjust path if needed
import * as win32 from './win32.js';

describe('win32 path implementation', () => {

  // -------------------------------------------------------------------------
  // resolve
  // -------------------------------------------------------------------------
  describe('resolve()', () => {
    test.each([
      [['C:\\foo', 'bar'], 'C:\\foo\\bar'],
      [['C:\\foo', '..\\bar'], 'C:\\bar'],
      [['C:\\foo', 'C:\\bar'], 'C:\\bar'],
      [['', 'foo'], 'C:\\foo'],
    ])('resolve(%o)', (args, expected) => {
      expect(win32.resolve(...args)).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // normalize
  // -------------------------------------------------------------------------
  describe('normalize()', () => {
    test.each([
      ['C:\\foo\\..\\bar', 'C:\\bar'],
      ['C:/foo//bar\\baz', 'C:\\foo\\bar\\baz'],
      ['foo\\..\\bar', 'bar'],
      ['.', '.'],
    ])('normalize(%s)', (input, expected) => {
      expect(win32.normalize(input)).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // isAbsolute
  // -------------------------------------------------------------------------
  describe('isAbsolute()', () => {
    test.each([
      ['C:\\foo', true],
      ['\\foo', true],
      ['foo\\bar', false],
      ['C:foo', false],
    ])('isAbsolute(%s)', (input, expected) => {
      expect(win32.isAbsolute(input)).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // join
  // -------------------------------------------------------------------------
  describe('join()', () => {
    test.each([
      [['C:\\foo', 'bar'], 'C:\\foo\\bar'],
      [['C:\\foo', '..', 'bar'], 'C:\\bar'],
      [['foo', 'bar', 'baz'], 'foo\\bar\\baz'],
      [[], '.'],
    ])('join(%o)', (args, expected) => {
      expect(win32.join(...args)).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // relative
  // -------------------------------------------------------------------------
  describe('relative()', () => {
    test.each([
      ['C:\\foo\\bar', 'C:\\foo\\baz', '..\\baz'],
      ['C:\\foo', 'C:\\foo\\bar', 'bar'],
      ['C:\\foo\\bar', 'C:\\foo\\bar', ''],
      ['C:\\Users\\Alice', 'C:\\users\\alice\\docs', 'docs'],
    ])('relative(%s, %s)', (from, to, expected) => {
      expect(win32.relative(from, to)).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // dirname
  // -------------------------------------------------------------------------
  describe('dirname()', () => {
    test.each([
      ['C:\\foo\\bar\\baz.txt', 'C:\\foo\\bar'],
      ['C:\\foo\\bar\\', 'C:\\foo'],
      ['C:\\', 'C:\\'],
      ['foo', '.'],
    ])('dirname(%s)', (input, expected) => {
      expect(win32.dirname(input)).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // basename
  // -------------------------------------------------------------------------
  describe('basename()', () => {
    test.each([
      ['C:\\foo\\bar.txt', undefined, 'bar.txt'],
      ['C:\\foo\\bar.txt', '.txt', 'bar'],
      ['C:\\foo\\bar', '.txt', 'bar'],
    ])('basename(%s)', (input, ext, expected) => {
      expect(win32.basename(input, ext)).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // extname
  // -------------------------------------------------------------------------
  describe('extname()', () => {
    test.each([
      ['file.txt', '.txt'],
      ['archive.tar.gz', '.gz'],
      ['noext', ''],
      ['.gitignore', ''],
    ])('extname(%s)', (input, expected) => {
      expect(win32.extname(input)).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // parse / format
  // -------------------------------------------------------------------------
  describe('parse() and format()', () => {
    test('parse basic path', () => {
      const parsed = win32.parse('C:\\foo\\bar.txt');
      expect(parsed).toEqual({
        root: 'C:\\',
        dir: 'C:\\foo',
        base: 'bar.txt',
        ext: '.txt',
        name: 'bar',
      });
    });

    test('format reconstructs path', () => {
      const obj = {
        root: 'C:\\',
        dir: 'C:\\foo',
        base: 'bar.txt',
        ext: '.txt',
        name: 'bar',
      };
      expect(win32.format(obj)).toBe('C:\\foo\\bar.txt');
    });
  });

  // -------------------------------------------------------------------------
  // edge cases
  // -------------------------------------------------------------------------
  describe('edge cases', () => {
    test('throws on non-string', () => {
      expect(() => win32.normalize(null)).toThrow();
    });

    test('empty string normalize', () => {
      expect(win32.normalize('')).toBe('.');
    });

    test('UNC path parse', () => {
      const parsed = win32.parse('\\\\server\\share\\file.txt');
      expect(parsed.root).toContain('\\\\server\\share');
    });
  });

});

// run tests
run().then(console.log);

*/
