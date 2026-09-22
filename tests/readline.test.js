import { describe, test, expect, afterEach } from '@jest/globals';
import readline, {
  createInterface,
  Interface,
  clearLine,
  clearScreenDown,
  createInterface as createInterfaceNamed,
  cursorTo,
  emitKeypressEvents,
  moveCursor,
  promises,
} from '../src/readline.js';
import { Readable, Writable } from '../src/stream.js';
import { EventEmitter } from '../src/events.js';
import { promisify } from '../src/util.js';

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

function collectWritable() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
  return { w, chunks };
}

// ─── module shape ────────────────────────────────────────────────────────────
describe('module shape', () => {
  test('exports exactly the Node callback API', () => {
    expect(Object.keys(readline).sort()).toEqual([
      'Interface', 'clearLine', 'clearScreenDown', 'createInterface',
      'cursorTo', 'emitKeypressEvents', 'moveCursor', 'promises',
    ]);
  });

  test('has no Readline export (unlike readline/promises)', () => {
    expect(readline.Readline).toBeUndefined();
  });

  test('named exports match the default export', () => {
    expect(createInterfaceNamed).toBe(createInterface);
    expect(readline.Interface).toBe(Interface);
    expect(readline.createInterface).toBe(createInterface);
    expect(readline.clearLine).toBe(clearLine);
    expect(readline.clearScreenDown).toBe(clearScreenDown);
    expect(readline.cursorTo).toBe(cursorTo);
    expect(readline.emitKeypressEvents).toBe(emitKeypressEvents);
    expect(readline.moveCursor).toBe(moveCursor);
    expect(readline.promises).toBe(promises);
  });

  test('does not pollute the global scope', () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'readline');
    // Node 24 ships a lazy global `readline`; our module must not replace it
    // with an own data property.
    expect(!desc || typeof desc.get === 'function').toBe(true);
  });
});

// ─── createInterface / Interface ─────────────────────────────────────────────
describe('readline (callback version)', () => {
  describe('createInterface()', () => {
    test('returns an Interface instance', () => {
      const rl = createInterface({ input: lineReadable([]), output: nullWritable() });
      expect(rl).toBeInstanceOf(Interface);
      rl.close();
    });

    test('Interface is callable without new', () => {
      const rl = Interface({ input: lineReadable([]) });
      expect(rl).toBeInstanceOf(Interface);
      rl.close();
    });

    test('accepts positional arguments', () => {
      const rl = createInterface(lineReadable([]), nullWritable());
      expect(rl).toBeInstanceOf(Interface);
      rl.close();
    });

    test('throws ERR_INVALID_ARG_VALUE for non-function completer', () => {
      for (const bad of ['x', 123, {}, true, null]) {
        expect(() => createInterface({ input: lineReadable([]), completer: bad }))
          .toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
      }
    });

    test('throws ERR_INVALID_ARG_TYPE for non-array history', () => {
      expect(() => createInterface({ input: lineReadable([]), history: 'x' }))
        .toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
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

    test('splits CR, LF, CRLF, U+2028 and U+2029 line endings', done => {
      const r = new Readable({ read() {} });
      r.push('a\rb\nc\r\nd\u2028e\u2029f\n');
      r.push(null);
      rl = createInterface({ input: r });
      const lines = [];
      rl.on('line', l => lines.push(l));
      rl.on('close', () => {
        expect(lines).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        done();
      });
    });

    test('handles EOF without trailing newline', done => {
      const r = new Readable({ read() {} });
      r.push('no newline');
      r.push(null);

      rl = createInterface({ input: r });

      const lines = [];
      rl.on('line', l => lines.push(l));

      rl.on('close', () => {
        expect(lines).toEqual(['no newline']);
        done();
      });
    });

    // ── close ────────────────────────────────────────────────────────────────
    test("emits 'close' after input ends", done => {
      rl = createInterface({ input: lineReadable(['x']) });
      rl.on('close', () => done());
    });

    test('close() emits close event and is idempotent', done => {
      rl = createInterface({ input: lineReadable([]) });
      let count = 0;
      rl.on('close', () => { count++; });
      rl.close();
      rl.close();
      setImmediate(() => {
        expect(count).toBe(1);
        done();
      });
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
      const { w, chunks } = collectWritable();

      rl = createInterface({ input: lineReadable(['yes']), output: w });

      rl.question('Continue? ', () => {
        expect(chunks.join('')).toContain('Continue?');
        done();
      });
    });

    test('question() is promisifiable via util.promisify', async () => {
      rl = createInterface({ input: lineReadable(['async answer']) });
      const answer = await promisify(rl.question).call(rl, 'Q? ');
      expect(answer).toBe('async answer');
    });

    test('question() with aborted signal invokes no callback', done => {
      const r = new Readable({ read() {} });
      rl = createInterface({ input: r });
      const ac = new AbortController();
      let called = false;
      rl.question('Q? ', { signal: ac.signal }, () => { called = true; });
      ac.abort();
      setImmediate(() => {
        expect(called).toBe(false);
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

    test('pause()/write() after close throw ERR_USE_AFTER_CLOSE', () => {
      rl = createInterface({ input: lineReadable([]) });
      rl.close();
      expect(() => rl.pause()).toThrow(expect.objectContaining({ code: 'ERR_USE_AFTER_CLOSE' }));
      expect(() => rl.write('x')).toThrow(expect.objectContaining({ code: 'ERR_USE_AFTER_CLOSE' }));
    });

    // ── prompt ───────────────────────────────────────────────────────────────
    test('setPrompt() / getPrompt()', () => {
      rl = createInterface({ input: lineReadable([]) });
      rl.setPrompt('$ ');
      expect(rl.getPrompt()).toBe('$ ');
    });

    test('getCursorPos() reflects prompt width', () => {
      rl = createInterface({ input: lineReadable([]) });
      expect(rl.getCursorPos()).toEqual({ cols: 2, rows: 0 });
    });

    // ── properties ───────────────────────────────────────────────────────────
    test('terminal is false without a TTY output', () => {
      rl = createInterface({ input: lineReadable([]) });
      expect(rl.terminal).toBe(false);
    });

    test('line starts as empty string', () => {
      rl = createInterface({ input: lineReadable([]) });
      expect(rl.line).toBe('');
    });

    test('cursor is undefined in non-terminal mode (matches Node)', () => {
      rl = createInterface({ input: lineReadable([]) });
      expect(rl.cursor).toBeUndefined();
    });

    test('cursor is 0 in terminal mode', () => {
      const input = new EventEmitter();
      input.resume = () => {};
      input.pause = () => {};
      const { w } = collectWritable();
      w.columns = 80;
      rl = createInterface({ input, output: w, terminal: true });
      expect(rl.terminal).toBe(true);
      expect(rl.cursor).toBe(0);
      expect(rl.escapeCodeTimeout).toBe(500);
      expect(rl.tabSize).toBe(8);
    });

    test('history defaults to [] with historySize 30', () => {
      rl = createInterface({ input: lineReadable([]) });
      expect(rl.history).toEqual([]);
      expect(rl.historySize).toBe(30);
    });

    // ── async iteration ──────────────────────────────────────────────────────
    test('async iterator yields lines', async () => {
      rl = createInterface({ input: lineReadable(['one', 'two']) });
      const lines = [];
      for await (const line of rl) lines.push(line);
      expect(lines).toEqual(['one', 'two']);
    });
  });

  // ── ANSI helpers ───────────────────────────────────────────────────────────
  describe('ANSI helpers', () => {
    test('cursorTo writes absolute column sequence', () => {
      const { w, chunks } = collectWritable();
      cursorTo(w, 5);
      expect(chunks.join('')).toBe('\x1b[6G');
    });

    test('cursorTo writes row/col sequence', () => {
      const { w, chunks } = collectWritable();
      cursorTo(w, 5, 10);
      expect(chunks.join('')).toBe('\x1b[11;6H');
    });

    test('moveCursor writes relative sequences', () => {
      const { w, chunks } = collectWritable();
      moveCursor(w, 3, -2);
      expect(chunks.join('')).toBe('\x1b[3C\x1b[2A');
    });

    test('moveCursor(0, 0) writes nothing', () => {
      const { w, chunks } = collectWritable();
      moveCursor(w, 0, 0);
      expect(chunks.join('')).toBe('');
    });

    test('clearLine writes erase sequences', () => {
      for (const [dir, seq] of [[0, '\x1b[2K'], [-1, '\x1b[1K'], [1, '\x1b[0K']]) {
        const { w, chunks } = collectWritable();
        clearLine(w, dir);
        expect(chunks.join('')).toBe(seq);
      }
    });

    test('clearScreenDown writes erase-below sequence', () => {
      const { w, chunks } = collectWritable();
      clearScreenDown(w);
      expect(chunks.join('')).toBe('\x1b[0J');
    });

    test('null stream returns true and fires callback async', done => {
      const ret = clearLine(null, 0, () => done());
      expect(ret).toBe(true);
    });

    test('cursorTo validates arguments like Node', () => {
      const { w } = collectWritable();
      expect(() => cursorTo(w, NaN))
        .toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
      expect(() => cursorTo(w, 1, () => {}, 'nope'))
        .toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    });
  });

  // ── emitKeypressEvents ─────────────────────────────────────────────────────
  describe('emitKeypressEvents', () => {
    test('decodes keypress events with Node key shapes', async () => {
      const s = new EventEmitter();
      const seen = [];
      emitKeypressEvents(s);
      s.on('keypress', (ch, key) => seen.push([ch, key]));
      s.emit('data', 'a');
      s.emit('data', '\r');
      s.emit('data', '\x1b[A');
      s.emit('data', '\x03');
      await new Promise(r => setImmediate(r));
      expect(seen[0]).toEqual(['a', {
        sequence: 'a', name: 'a', ctrl: false, meta: false, shift: false,
      }]);
      expect(seen[1][1]).toMatchObject({ sequence: '\r', name: 'return', ctrl: false });
      expect(seen[2][1]).toMatchObject({ sequence: '\x1b[A', name: 'up', code: '[A' });
      expect(seen[3][1]).toMatchObject({ sequence: '\x03', name: 'c', ctrl: true });
    });
  });
});
