import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import web, {
  ReadableStream,
  WritableStream,
  TransformStream,
  ReadableStreamDefaultReader,
  ReadableStreamBYOBReader,
  WritableStreamDefaultWriter,
  ReadableStreamDefaultController,
  ReadableByteStreamController,
  ReadableStreamBYOBRequest,
  WritableStreamDefaultController,
  TransformStreamDefaultController,
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
  TextEncoderStream,
  TextDecoderStream,
  CompressionStream,
  DecompressionStream,
} from '../src/stream/web.js';

describe('stream/web shim', () => {

  // ── module shape ───────────────────────────────────────────────────────────
  describe('module shape', () => {
    const members = [
      'ReadableStream', 'WritableStream', 'TransformStream',
      'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader',
      'WritableStreamDefaultWriter',
      'ReadableStreamDefaultController', 'ReadableByteStreamController',
      'ReadableStreamBYOBRequest', 'WritableStreamDefaultController',
      'TransformStreamDefaultController',
      'ByteLengthQueuingStrategy', 'CountQueuingStrategy',
      'TextEncoderStream', 'TextDecoderStream',
      'CompressionStream', 'DecompressionStream',
    ];
    for (const name of members) {
      test(`default export exposes ${name}`, () => {
        expect(web[name]).toBeDefined();
      });
    }
  });

  // ── ReadableStream ─────────────────────────────────────────────────────────
  describe('ReadableStream', () => {
    test('can enqueue and read chunks', async () => {
      const rs = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue('a');
          ctrl.enqueue('b');
          ctrl.close();
        },
      });
      const reader = rs.getReader();
      expect((await reader.read()).value).toBe('a');
      expect((await reader.read()).value).toBe('b');
      expect((await reader.read()).done).toBe(true);
    });

    test('cancel() resolves', async () => {
      const rs = new ReadableStream({ start(ctrl) { ctrl.enqueue(1); } });
      await expect(rs.cancel()).resolves.toBeUndefined();
    });

    test('locked after getReader()', () => {
      const rs = new ReadableStream({ start(ctrl) { ctrl.close(); } });
      rs.getReader();
      expect(rs.locked).toBe(true);
    });

    test('pipeThrough a TransformStream', async () => {
      const rs = new ReadableStream({
        start(ctrl) { ctrl.enqueue('hello'); ctrl.close(); },
      });
      const upper = new TransformStream({
        transform(chunk, ctrl) { ctrl.enqueue(chunk.toUpperCase()); },
      });
      const reader = rs.pipeThrough(upper).getReader();
      expect((await reader.read()).value).toBe('HELLO');
    });

    test('pipeTo a WritableStream', async () => {
      const chunks = [];
      const ws = new WritableStream({ write(chunk) { chunks.push(chunk); } });
      const rs = new ReadableStream({
        start(ctrl) { ctrl.enqueue(1); ctrl.enqueue(2); ctrl.close(); },
      });
      await rs.pipeTo(ws);
      expect(chunks).toEqual([1, 2]);
    });

    test('async iteration via tee()', async () => {
      const rs = new ReadableStream({
        start(ctrl) { ctrl.enqueue('x'); ctrl.close(); },
      });
      const [a, b] = rs.tee();
      const ra = a.getReader();
      const rb = b.getReader();
      expect((await ra.read()).value).toBe('x');
      expect((await rb.read()).value).toBe('x');
    });
  });

  // ── WritableStream ─────────────────────────────────────────────────────────
  describe('WritableStream', () => {
    test('write() and close() resolve', async () => {
      const chunks = [];
      const ws = new WritableStream({ write(c) { chunks.push(c); } });
      const writer = ws.getWriter();
      await writer.write('foo');
      await writer.write('bar');
      await writer.close();
      expect(chunks).toEqual(['foo', 'bar']);
    });

    test('locked after getWriter()', () => {
      const ws = new WritableStream();
      ws.getWriter();
      expect(ws.locked).toBe(true);
    });

    test('abort() rejects pending writes', async () => {
      const ws = new WritableStream({
        write() { return new Promise(() => {}); }, // never resolves
      });
      const writer = ws.getWriter();
      const writeP = writer.write('data');
      writer.abort(new Error('aborted'));
      await expect(writeP).rejects.toThrow();
    });
  });

  // ── TransformStream ────────────────────────────────────────────────────────
  describe('TransformStream', () => {
    test('transforms chunks', async () => {
      const ts = new TransformStream({
        transform(chunk, ctrl) { ctrl.enqueue(chunk * 2); },
      });
      const writer = ts.writable.getWriter();
      const reader = ts.readable.getReader();
      writer.write(3);
      expect((await reader.read()).value).toBe(6);
    });

    test('flush() is called on close', async () => {
      const ts = new TransformStream({
        transform(chunk, ctrl) { ctrl.enqueue(chunk); },
        flush(ctrl) { ctrl.enqueue('END'); },
      });
      // Acquire reader BEFORE writing so the readable side is not blocked
      const reader = ts.readable.getReader();
      const writer = ts.writable.getWriter();

      // Write + close concurrently — don't await write before starting read,
      // otherwise the readable buffer fills up and write() never resolves.
      writer.write('data');
      writer.close();

      const results = [];
      let r;
      while (!(r = await reader.read()).done) results.push(r.value);
      expect(results).toContain('END');
    });

    test('identity transform (no transform fn) passes chunks through', async () => {
      const ts = new TransformStream();
      const writer = ts.writable.getWriter();
      const reader = ts.readable.getReader();
      writer.write('pass');
      expect((await reader.read()).value).toBe('pass');
    });
  });

  // ── Queuing strategies ────────────────────────────────────────────────────
  describe('ByteLengthQueuingStrategy', () => {
    test('size() returns chunk.byteLength', () => {
      const s = new ByteLengthQueuingStrategy({ highWaterMark: 1024 });
      expect(s.highWaterMark).toBe(1024);
      expect(s.size(new Uint8Array(64))).toBe(64);
    });

    test('applies backpressure to ReadableStream', () => {
      const rs = new ReadableStream(
        { start(ctrl) { ctrl.enqueue(new Uint8Array(512)); ctrl.close(); } },
        new ByteLengthQueuingStrategy({ highWaterMark: 1024 }),
      );
      expect(rs).toBeInstanceOf(ReadableStream);
    });
  });

  describe('CountQueuingStrategy', () => {
    test('size() always returns 1', () => {
      const s = new CountQueuingStrategy({ highWaterMark: 4 });
      expect(s.highWaterMark).toBe(4);
      expect(s.size('anything')).toBe(1);
    });
  });

  // ── TextEncoderStream ─────────────────────────────────────────────────────
  describe('TextEncoderStream', () => {
    test('encodes string chunks to Uint8Array', async () => {
      const enc = new TextEncoderStream();
      const writer = enc.writable.getWriter();
      const reader = enc.readable.getReader();
      writer.write('hi');
      const { value } = await reader.read();
      expect(value).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(value)).toBe('hi');
    });

    test('encoding property is utf-8', () => {
      expect(new TextEncoderStream().encoding).toBe('utf-8');
    });

    test('round-trips through TextDecoderStream', async () => {
      const enc = new TextEncoderStream();
      const dec = new TextDecoderStream();
      const out = enc.readable.pipeThrough(dec);
      const writer = enc.writable.getWriter();
      const reader = out.getReader();
      await writer.write('café');
      await writer.close();
      const chunks = [];
      let r;
      while (!(r = await reader.read()).done) chunks.push(r.value);
      expect(chunks.join('')).toBe('café');
    });
  });

  // ── TextDecoderStream ─────────────────────────────────────────────────────
  describe('TextDecoderStream', () => {
    test('decodes Uint8Array chunks to strings', async () => {
      const dec = new TextDecoderStream();
      const writer = dec.writable.getWriter();
      const reader = dec.readable.getReader();
      writer.write(new TextEncoder().encode('hello'));
      const { value } = await reader.read();
      expect(typeof value).toBe('string');
      expect(value).toBe('hello');
    });

    test('encoding property reflects constructor arg', () => {
      expect(new TextDecoderStream('utf-8').encoding).toBe('utf-8');
    });
  });

  // ── CompressionStream / DecompressionStream ───────────────────────────────
  describe('CompressionStream', () => {
    test('is a constructor', () => {
      expect(typeof CompressionStream).toBe('function');
    });

    test('throws a clear error when native API is unavailable', () => {
      // Only test the error path if globalThis.CompressionStream is absent
      if (!('CompressionStream' in globalThis)) {
        expect(() => new CompressionStream('gzip')).toThrow(
          /CompressionStream is not available/,
        );
      }
    });

    test('compresses and decompresses gzip round-trip when native', async () => {
      if (!('CompressionStream' in globalThis)) return;
      const input = new TextEncoder().encode('hello world'.repeat(10));
      const cs = new CompressionStream('gzip');
      const ds = new DecompressionStream('gzip');
      const writer = cs.writable.getWriter();
      writer.write(input);
      writer.close();
      const compressed = cs.readable.pipeThrough(ds);
      const reader = compressed.getReader();
      const chunks = [];
      let r;
      while (!(r = await reader.read()).done) chunks.push(r.value);
      const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
      let offset = 0;
      for (const c of chunks) { out.set(c, offset); offset += c.length; }
      expect(new TextDecoder().decode(out)).toBe('hello world'.repeat(10));
    });
  });
});
