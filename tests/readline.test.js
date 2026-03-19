import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { createInterface, Interface, Readline } from '../src/readline.js';
import { Readable, Writable } from '../src/stream.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function lineReadable(lines) {
  const r = new Readable({ read() {} });
  for (const l of lines) r.push(l + '\n');
  r.push(null);
  return r;
}

function nullWritable() {
  return new Writable({ write(_c, _e, cb) { cb(); } });
}

// ─── createInterface / Interface ──────────────────────────────────────────────
describe('readline (callback version)', () => {

  describe('createInterface()', () => {
    test('returns an Interface instance', () => {
      const rl = createInterface({ input: lineReadable([]), output: nullWritable() });
      expect(rl).toBeInstanceOf(Interface);
      rl.close();
    });
  });

  describe('Interface', () => {
    let rl;

    afterEach(() => {
      rl?.close();
    });

    // ── 'line' event ─────────────────────────────────────────────────────────
    test("emits 'line' event for each line", done => {
      rl = createInterface({ input: lineReadable(['foo', 'bar', 'baz']) });

      const lines = [];
      rl.on('line', l => lines.push(l));

      rl.on('close', () => {
        expect(lines).toEqual(['foo', 'bar', 'baz']);
        done();
      });
    });

    test('strips trailing newline', done => {
      const r = new Readable({ read() {} });
      r.push('hello\nworld\n');
      r.push(null);

      rl = createInterface({ input: r });

      const lines = [];
      rl.on('line', l => lines.push(l));

      rl.on('close', () => {
        expect(lines).toEqual(['hello', 'world']);
        done();
      });
    });

    test('handles EOF without newline', done => {
      const r = new Readable({ read() {} });
      r.push('no newline');
      r.push(null);

      rl = createInterface({ input: r });

      const lines = [];
      rl.on('line', l => lines.push(l));

      rl.on('close', () => {
        expect(lines).toContain('no newline');
        done();
      });
    });

    // ── close ────────────────────────────────────────────────────────────────
    test("emits 'close' after input ends", done => {
      rl = createInterface({ input: lineReadable(['x']) });
      rl.on('close', () => done());
    });

    test('close() emits close event', done => {
      rl = createInterface({ input: lineReadable([]) });
      rl.on('close', () => done());
      rl.close();
    });

    // ── question() (callback version) ────────────────────────────────────────
    test('question() invokes callback with answer', done => {
      rl = createInterface({ input: lineReadable(['my answer']) });

      rl.question('Prompt: ', (answer) => {
        expect(answer).toBe('my answer');
        done();
      });
    });

    test('question() writes prompt to output', done => {
      const chunks = [];
      const out = new Writable({
        write(c, _e, cb) {
          chunks.push(c.toString());
          cb();
        },
      });

      rl = createInterface({ input: lineReadable(['yes']), output: out });

      rl.question('Continue? ', () => {
        expect(chunks.join('')).toContain('Continue?');
        done();
      });
    });

    // ── pause / resume ───────────────────────────────────────────────────────
    test('pause() and resume() do not throw', () => {
      rl = createInterface({ input: lineReadable([]) });
      expect(() => { rl.pause(); rl.resume(); }).not.toThrow();
    });

    test("pause() emits 'pause' event", done => {
      rl = createInterface({ input: lineReadable([]) });
      rl.on('pause', () => done());
      rl.pause();
    });

    test("resume() emits 'resume' event", done => {
      rl = createInterface({ input: lineReadable([]) });
      rl.pause();
      rl.on('resume', () => done());
      rl.resume();
    });

    // ── prompt ───────────────────────────────────────────────────────────────
    test('setPrompt() / getPrompt()', () => {
      rl = createInterface({ input: lineReadable([]) });
      rl.setPrompt('> ');
      expect(rl.getPrompt()).toBe('> ');
    });

    // ── properties ───────────────────────────────────────────────────────────
    test('terminal is false when no output', () => {
      rl = createInterface({ input: lineReadable([]) });
      expect(rl.terminal).toBe(false);
    });

    test('line is string', () => {
      rl = createInterface({ input: lineReadable([]) });
      expect(typeof rl.line).toBe('string');
    });

    test('cursor is number', () => {
      rl = createInterface({ input: lineReadable([]) });
      expect(typeof rl.cursor).toBe('number');
    });
  });

  // ── Readline controller ────────────────────────────────────────────────────
  describe('Readline', () => {
    let rl, readline;

    beforeEach(() => {
      rl = createInterface({ input: lineReadable([]), output: nullWritable() });
      readline = new Readline(rl);
    });

    afterEach(() => {
      rl.close();
    });

    test('instantiates correctly', () => {
      expect(readline).toBeInstanceOf(Readline);
    });

    test('clearLine() chains', () => {
      expect(readline.clearLine(0)).toBe(readline);
    });

    test('clearScreenDown() chains', () => {
      expect(readline.clearScreenDown()).toBe(readline);
    });

    test('moveCursor() chains', () => {
      expect(readline.moveCursor(0, 0)).toBe(readline);
    });

    test('rollback() chains', () => {
      expect(readline.rollback()).toBe(readline);
    });

    // non-promises version: commit might be sync
    test('commit() does not throw', () => {
      expect(() => readline.commit()).not.toThrow();
    });
  });
});
