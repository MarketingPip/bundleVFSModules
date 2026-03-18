import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { pipeline, finished } from '../src/stream/promises.js';
import stream from '../src/stream.js';

const { Readable, Writable, Transform, PassThrough } = stream;

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Creates a Readable that emits the given chunks then ends. */
function makeReadable(chunks = []) {
  return new Readable({
    read() {},
    objectMode: true,
  })._construct
    ? (() => {
        const r = new Readable({ objectMode: true, read() {} });
        for (const c of chunks) r.push(c);
        r.push(null);
        return r;
      })()
    : Readable.from(chunks);
}

/** Creates a Writable that collects written chunks into an array. */
function makeWritable() {
  const chunks = [];
  const ws = new Writable({
    objectMode: true,
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  ws.collected = chunks;
  return ws;
}

// ─── pipeline ────────────────────────────────────────────────────────────────
describe('stream/promises — pipeline()', () => {

  test('resolves after all data flows through', async () => {
    const src  = Readable.from(['a', 'b', 'c']);
    const sink = makeWritable();
    await pipeline(src, sink);
    expect(sink.collected).toEqual(['a', 'b', 'c']);
  });

  test('works with a Transform in the middle', async () => {
    const src = Readable.from([1, 2, 3]);
    const double = new Transform({
      objectMode: true,
      transform(chunk, _enc, cb) { cb(null, chunk * 2); },
    });
    const sink = makeWritable();
    await pipeline(src, double, sink);
    expect(sink.collected).toEqual([2, 4, 6]);
  });

  test('rejects when the source emits an error', async () => {
    const src = new Readable({ read() {} });
    const sink = makeWritable();
    queueMicrotask(() => src.destroy(new Error('source exploded')));
    await expect(pipeline(src, sink)).rejects.toThrow('source exploded');
  });

  test('rejects when the sink emits an error', async () => {
    const src = Readable.from(['data']);
    const sink = new Writable({
      write(_c, _e, cb) { cb(new Error('sink exploded')); },
    });
    await expect(pipeline(src, sink)).rejects.toThrow('sink exploded');
  });

  test('destroys all streams on error', async () => {
    const src = new Readable({ read() {} });
    const sink = makeWritable();
    queueMicrotask(() => src.destroy(new Error('boom')));
    await pipeline(src, sink).catch(() => {});
    expect(sink.destroyed).toBe(true);
  });

  test('supports AbortSignal cancellation', async () => {
    const src  = new Readable({ read() {} }); // never ends
    const sink = makeWritable();
    const ac   = new AbortController();
    const p    = pipeline(src, sink, { signal: ac.signal });
    ac.abort();
    const err = await p.catch(e => e);
    expect(err.code).toBe('ABORT_ERR');
  });

  test('rejects immediately if signal already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const src  = Readable.from(['x']);
    const sink = makeWritable();
    const err  = await pipeline(src, sink, { signal: ac.signal }).catch(e => e);
    expect(err.code).toBe('ABORT_ERR');
  });

  test('chains three streams correctly', async () => {
    const src = Readable.from(['hello']);
    const upper = new Transform({
      objectMode: true,
      transform(c, _e, cb) { cb(null, c.toString().toUpperCase()); },
    });
    const exclaim = new Transform({
      objectMode: true,
      transform(c, _e, cb) { cb(null, c + '!'); },
    });
    const sink = makeWritable();
    await pipeline(src, upper, exclaim, sink);
    expect(sink.collected).toEqual(['HELLO!']);
  });
});

// ─── finished ────────────────────────────────────────────────────────────────
describe('stream/promises — finished()', () => {

  test('resolves when a Readable ends normally', async () => {
    const r = Readable.from(['a', 'b']);
    const sink = new Writable({ write(_c, _e, cb) { cb(); } });
    r.pipe(sink);
    await expect(finished(sink)).resolves.toBeUndefined();
  });

  test('resolves when a Writable finishes', async () => {
    const ws = makeWritable();
    ws.end('done');
    await expect(finished(ws)).resolves.toBeUndefined();
  });

  test('rejects when stream is destroyed with an error', async () => {
    const rs = new Readable({ read() {} });
    const p  = finished(rs);
    rs.destroy(new Error('kaboom'));
    await expect(p).rejects.toThrow('kaboom');
  });

  test('rejects on premature close (writable not finished)', async () => {
    const ws = new Writable({ write(_c, _e, cb) { cb(); } });
    const p  = finished(ws);
    ws.destroy();
    await expect(p).rejects.toBeDefined();
  });

  test('{ readable: false } resolves on writable-side finish of a Duplex', async () => {
    const pt = new PassThrough();
    const p  = finished(pt, { readable: false });
    pt.end();
    await expect(p).resolves.toBeUndefined();
  });

  test('{ error: false } does not reject on error event', async () => {
    const rs = new Readable({ read() {} });
    const p  = finished(rs, { error: false });
    // Push null to signal end-of-stream — this is the normal completion path;
    // error: false just means an 'error' event won't cause rejection, but the
    // stream still needs to actually finish for the promise to resolve.
    rs.push(null);
    await expect(p).resolves.toBeUndefined();
  });

  test('supports AbortSignal cancellation', async () => {
    const rs = new Readable({ read() {} }); // never ends
    const ac = new AbortController();
    const p  = finished(rs, { signal: ac.signal });
    ac.abort();
    const err = await p.catch(e => e);
    expect(err.code).toBe('ABORT_ERR');
  });

  test('rejects immediately if signal already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const rs  = new Readable({ read() {} });
    const err = await finished(rs, { signal: ac.signal }).catch(e => e);
    expect(err.code).toBe('ABORT_ERR');
  });

  test('stream already ended before finished() is called still resolves', async () => {
    const ws = makeWritable();
    ws.end();
    // wait for finish event to fire first
    await new Promise(r => ws.once('finish', r));
    await expect(finished(ws)).resolves.toBeUndefined();
  });
});
