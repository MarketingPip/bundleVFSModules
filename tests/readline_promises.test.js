import { describe, test, expect, afterEach } from '@jest/globals';
import readlinePromises, {
  createInterface,
  Interface,
  Readline,
} from '../src/readline/promises.js';
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

function collectWritable() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
  return { w, chunks };
}

// ─── module shape ────────────────────────────────────────────────────────────
describe('module shape', () => {
  test('exports exactly Interface, Readline and createInterface', () => {
    expect(Object.keys(readlinePromises).sort()).toEqual([
      'Interface', 'Readline', 'createInterface',
    ]);
  });

  test('has no callback-style clearLine/moveCursor/cursorTo helpers', () => {
    expect(readlinePromises.clearLine).toBeUndefined();
    expect(readlinePromises.cursorTo).toBeUndefined();
    expect(readlinePromises.moveCursor).toBeUndefined();
  });

  test('named exports match the default export', () => {
    expect(readlinePromises.Interface).toBe(Interface);
    expect(readlinePromises.Readline).toBe(Readline);
    expect(readlinePromises.createInterface).toBe(createInterface);
  });

  test('Readline is an output controller class, not an Interface', () => {
    expect(typeof Readline).toBe('function');
    expect(Readline.prototype).not.toBe(Interface.prototype);
  });
});

// ─── Interface (promises) ────────────────────────────────────────────────────
describe('readline/promises Interface', () => {
  let rl;

  afterEach(() => {
    rl?.close();
  });

  test('createInterface returns an Interface instance', () => {
    rl = createInterface({ input: lineReadable([]), output: nullWritable() });
    expect(rl).toBeInstanceOf(Interface);
  });

  test('cursor is undefined in non-terminal mode (matches Node)', () => {
    rl = createInterface({ input: lineReadable([]), output: nullWritable() });
    expect(rl.cursor).toBeUndefined();
    expect(rl.terminal).toBe(false);
  });

  test("emits 'line' for each line and 'close' at EOF", async () => {
    rl = createInterface({ input: lineReadable(['foo', 'bar']) });
    const lines = [];
    rl.on('line', l => lines.push(l));
    await new Promise(resolve => rl.on('close', resolve));
    expect(lines).toEqual(['foo', 'bar']);
  });

  test('question() resolves with the answer', async () => {
    rl = createInterface({ input: lineReadable(['answer']) });
    await expect(rl.question('Prompt? ')).resolves.toBe('answer');
  });

  test('question() rejects with AbortError when aborted', async () => {
    const r = new Readable({ read() {} });
    rl = createInterface({ input: r });
    const ac = new AbortController();
    const p = rl.question('Q?', { signal: ac.signal });
    ac.abort();
    const err = await p.catch(e => e);
    expect(err.code).toBe('ABORT_ERR');
  });

  test('question() rejects when the signal is already aborted', async () => {
    const r = new Readable({ read() {} });
    rl = createInterface({ input: r });
    const ac = new AbortController();
    ac.abort();
    await expect(rl.question('Q?', { signal: ac.signal })).rejects
      .toMatchObject({ code: 'ABORT_ERR' });
  });

  test('async iterator yields lines', async () => {
    rl = createInterface({ input: lineReadable(['a', 'b', 'c']) });
    const lines = [];
    for await (const line of rl) lines.push(line);
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  test('pause()/resume()/write() after close throw ERR_USE_AFTER_CLOSE', () => {
    rl = createInterface({ input: lineReadable([]) });
    rl.close();
    expect(() => rl.pause())
      .toThrow(expect.objectContaining({ code: 'ERR_USE_AFTER_CLOSE' }));
    expect(() => rl.resume())
      .toThrow(expect.objectContaining({ code: 'ERR_USE_AFTER_CLOSE' }));
    expect(() => rl.write('x'))
      .toThrow(expect.objectContaining({ code: 'ERR_USE_AFTER_CLOSE' }));
  });

  test('question() after close rejects with ERR_USE_AFTER_CLOSE', async () => {
    rl = createInterface({ input: lineReadable([]) });
    rl.close();
    await expect(rl.question('Q?')).rejects
      .toMatchObject({ code: 'ERR_USE_AFTER_CLOSE' });
  });

  test('close() is idempotent and emits close once', async () => {
    rl = createInterface({ input: lineReadable([]) });
    let count = 0;
    rl.on('close', () => { count++; });
    rl.close();
    rl.close();
    await new Promise(r => setImmediate(r));
    expect(count).toBe(1);
  });
});

// ─── Readline (promises output controller) ───────────────────────────────────
describe('readline/promises Readline', () => {
  test('constructs with a Writable stream', () => {
    const rl = new Readline(nullWritable());
    expect(rl).toBeInstanceOf(Readline);
  });

  test('throws ERR_INVALID_ARG_TYPE for non-writable output', () => {
    for (const bad of [null, undefined, {}, 'x']) {
      expect(() => new Readline(bad))
        .toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    }
  });

  test('default autoCommit is false: writes queue until commit()', async () => {
    const { w, chunks } = collectWritable();
    const rl = new Readline(w);
    rl.cursorTo(5);
    await new Promise(r => setImmediate(r));
    expect(chunks.join('')).toBe('');
    await rl.commit();
    expect(chunks.join('')).toBe('\x1b[6G');
  });

  test('autoCommit: true writes on next tick without commit()', async () => {
    const { w, chunks } = collectWritable();
    const rl = new Readline(w, { autoCommit: true });
    rl.cursorTo(1, 1);
    expect(chunks.join('')).toBe('');
    await new Promise(r => setImmediate(r));
    expect(chunks.join('')).toBe('\x1b[2;2H');
  });

  test('extra cursorTo arguments are ignored like Node', async () => {
    const { w, chunks } = collectWritable();
    const rl = new Readline(w);
    expect(() => rl.cursorTo(1, 2, 3)).not.toThrow();
    await rl.commit();
    expect(chunks.join('')).toBe('\x1b[3;2H');
  });

  test('clearLine with out-of-range direction throws ERR_OUT_OF_RANGE', () => {
    const rl = new Readline(nullWritable());
    expect(() => rl.clearLine(99))
      .toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
    expect(() => rl.clearLine(1.5))
      .toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
    expect(() => rl.clearLine('x'))
      .toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });

  test('cursorTo with non-integer coordinates throws ERR_OUT_OF_RANGE', () => {
    const rl = new Readline(nullWritable());
    expect(() => rl.cursorTo(1.5))
      .toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
    expect(() => rl.cursorTo('x'))
      .toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });

  test('rollback() discards queued operations', async () => {
    const { w, chunks } = collectWritable();
    const rl = new Readline(w, { autoCommit: false });
    rl.cursorTo(100, 100);
    rl.rollback();
    await rl.commit();
    expect(chunks.join('')).toBe('');
  });

  test('chained calls return the Readline instance', () => {
    const rl = new Readline(nullWritable());
    expect(rl.clearLine(0).clearScreenDown().cursorTo(0).moveCursor(0, 0)).toBe(rl);
  });

  test('ANSI sequences match Node byte-for-byte', async () => {
    const cases = [
      [rl => rl.cursorTo(5), '\x1b[6G'],
      [rl => rl.cursorTo(5, 10), '\x1b[11;6H'],
      [rl => rl.moveCursor(3, -2), '\x1b[3C\x1b[2A'],
      [rl => rl.clearLine(0), '\x1b[2K'],
      [rl => rl.clearLine(-1), '\x1b[1K'],
      [rl => rl.clearLine(1), '\x1b[0K'],
      [rl => rl.clearScreenDown(), '\x1b[0J'],
    ];
    for (const [fn, expected] of cases) {
      const { w, chunks } = collectWritable();
      const rl = new Readline(w, { autoCommit: false });
      fn(rl);
      await rl.commit();
      expect(chunks.join('')).toBe(expected);
    }
  });

  test('non-boolean autoCommit throws ERR_INVALID_ARG_TYPE', () => {
    expect(() => new Readline(nullWritable(), { autoCommit: 'yes' }))
      .toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });
});
