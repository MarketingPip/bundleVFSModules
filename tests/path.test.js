// No imports needed for describe/test/expect in Jest

// adjust path if needed
import * as win32 from '../src/path/win32.js';

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
