import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { createInterface, Interface, Readline } from '../src/readline/promises.js';
import { Readable, Writable } from '../src/stream.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Readable that emits lines then ends. */
function lineReadable(lines) {
  const r = new Readable({ read() {} });
  for (const l of lines) r.push(l + '\n');
  r.push(null);
  return r;
}

/** Writable that discards output (stdout stub). */
function nullWritable() {
  return new Writable({ write(_c, _e, cb) { cb(); } });
}

// ─── createInterface / Interface ──────────────────────────────────────────────
describe('readline/promises', () => {

  describe('createInterface()', () => {
    test('returns an Interface instance', () => {
      const rl = createInterface({ input: lineReadable([]), output: nullWritable() });
      expect(rl).toBeInstanceOf(Interface);
      rl.close();
    });

    test('accepts input/output options object', () => {
      expect(() => {
        const rl = createInterface({ input: lineReadable([]), output: nullWritable() });
        rl.close();
      }).not.toThrow();
    });
  });

  describe('Interface', () => {
    let rl;

    afterEach(() => {
      rl?.close();
    });

    // ── async iteration ──────────────────────────────────────────────────────
    test('async iteration yields each line', async () => {
      rl = createInterface({ input: lineReadable(['foo', 'bar', 'baz']) });
      const lines = [];
      for await (const line of rl) lines.push(line);
      expect(lines).toEqual(['foo', 'bar', 'baz']);
    });

    test('async iteration on empty input yields nothing', async () => {
      rl = createInterface({ input: lineReadable([]) });
      const lines = [];
      for await (const line of rl) lines.push(line);
      expect(lines).toHaveLength(0);
    });

    test('strips trailing newline from each line', async () => {
      const r = new Readable({ read() {} });
      r.push('hello\nworld\n');
      r.push(null);
      rl = createInterface({ input: r });
      const lines = [];
      for await (const line of rl) lines.push(line);
      expect(lines).toEqual(['hello', 'world']);
    });

    test('handles lines without trailing newline at EOF', async () => {
      const r = new Readable({ read() {} });
      r.push('no newline');
      r.push(null);
      rl = createInterface({ input: r });
      const lines = [];
      for await (const line of rl) lines.push(line);
      expect(lines).toContain('no newline');
    });

    // ── 'line' event ─────────────────────────────────────────────────────────
    test("emits 'line' event for each line", done => {
      rl = createInterface({ input: lineReadable(['alpha', 'beta']) });
      const seen = [];
      rl.on('line', l => seen.push(l));
      rl.on('close', () => {
        expect(seen).toEqual(['alpha', 'beta']);
        done();
      });
    });

    // ── 'close' event ────────────────────────────────────────────────────────
    test("emits 'close' after input ends", done => {
      rl = createInterface({ input: lineReadable(['x']) });
      rl.on('close', () => done());
    });

    test('close() emits close event', done => {
      rl = createInterface({ input: lineReadable([]) });
      rl.on('close', () => done());
      rl.close();
    });

    // ── question() ───────────────────────────────────────────────────────────
    test('question() resolves with the next line of input', async () => {
      rl = createInterface({ input: lineReadable(['my answer']) });
      const answer = await rl.question('Prompt: ');
      expect(answer).toBe('my answer');
    });

    test('question() writes prompt to output', async () => {
      const chunks = [];
      const out = new Writable({
        write(c, _e, cb) { chunks.push(c.toString()); cb(); },
      });
      rl = createInterface({ input: lineReadable(['yes']), output: out });
      await rl.question('Continue? ');
      expect(chunks.join('')).toContain('Continue?');
    });

    test('question() with AbortSignal rejects when aborted', async () => {
      const r = new Readable({ read() {} }); // never sends input
      rl = createInterface({ input: r });
      const ac = new AbortController();
      const p = rl.question('Q: ', { signal: ac.signal });
      ac.abort();
      await expect(p).rejects.toThrow();
    });

    test('question() with already-aborted signal rejects immediately', async () => {
      const ac = new AbortController();
      ac.abort();
      rl = createInterface({ input: lineReadable(['ignored']) });
      await expect(rl.question('Q: ', { signal: ac.signal })).rejects.toThrow();
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

    // ── setPrompt / getPrompt ────────────────────────────────────────────────
    test('setPrompt() / getPrompt() round-trip', () => {
      rl = createInterface({ input: lineReadable([]) });
      rl.setPrompt('> ');
      expect(rl.getPrompt()).toBe('> ');
    });

    // ── terminal property ────────────────────────────────────────────────────
    test('terminal is false when no output supplied', () => {
      rl = createInterface({ input: lineReadable([]) });
      expect(rl.terminal).toBe(false);
    });

    // ── line / cursor properties ─────────────────────────────────────────────
    test('line property is a string', () => {
      rl = createInterface({ input: lineReadable([]) });
      expect(typeof rl.line).toBe('string');
    });

    test('cursor property is a number', () => {
      rl = createInterface({ input: lineReadable([]) });
      expect(typeof rl.cursor).toBe('number');
    });
  });

  // ── Readline (output controller) ─────────────────────────────────────────
  describe('Readline', () => {
    let rl, readline;

    beforeEach(() => {
      rl = createInterface({ input: lineReadable([]), output: nullWritable() });
      readline = new Readline(rl);
    });

    afterEach(() => {
      rl.close();
    });

    test('can be instantiated with an Interface', () => {
      expect(readline).toBeInstanceOf(Readline);
    });

    test('clearLine() returns the Readline instance for chaining', () => {
      expect(readline.clearLine(0)).toBe(readline);
    });

    test('clearScreenDown() returns the Readline instance for chaining', () => {
      expect(readline.clearScreenDown()).toBe(readline);
    });

    test('moveCursor() returns the Readline instance for chaining', () => {
      expect(readline.moveCursor(0, 0)).toBe(readline);
    });

    test('commit() returns a Promise', () => {
      expect(readline.commit()).toBeInstanceOf(Promise);
    });

    test('commit() resolves', async () => {
      await expect(readline.commit()).resolves.toBeUndefined();
    });

    test('rollback() returns the Readline instance for chaining', () => {
      expect(readline.rollback()).toBe(readline);
    });
  });
});
