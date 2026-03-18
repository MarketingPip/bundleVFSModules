import { Buffer } from 'buffer';
import { 
  arrayBuffer, 
  blob, 
  buffer, 
  json, 
  text 
} from '../src/stream/consumers.js';

/**
 * Helper to create a Web ReadableStream from a string
 */
function createWebStream(content) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    }
  });
}

/**
 * Helper to create a Mock Node.js-like Iterable/Stream
 * Node 16.5+ consumers actually just need an AsyncIterable
 */
async function* createAsyncIterable(content) {
  yield Buffer.from(content);
}

describe('stream-consumers shim', () => {
  const mockData = { hello: "world", numbers: [1, 2, 3] };
  const jsonString = JSON.stringify(mockData);

  describe('text()', () => {
    test('consumes a Web ReadableStream to string', async () => {
      const stream = createWebStream("hello world");
      const result = await text(stream);
      expect(result).toBe("hello world");
    });

    test('consumes an AsyncIterable to string', async () => {
      const iterable = createAsyncIterable("async hello");
      const result = await text(iterable);
      expect(result).toBe("async hello");
    });
  });

  describe('buffer()', () => {
    test('returns a Node-style Buffer', async () => {
      const stream = createWebStream("buffer test");
      const result = await buffer(stream);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString()).toBe("buffer test");
    });
  });

  describe('json()', () => {
    test('parses stream content as JSON', async () => {
      const stream = createWebStream(jsonString);
      const result = await json(stream);
      expect(result).toEqual(mockData);
    });

    test('throws SyntaxError on invalid JSON', async () => {
      const stream = createWebStream("{ invalid json }");
      await expect(json(stream)).rejects.toThrow(SyntaxError);
    });
  });

  describe('arrayBuffer()', () => {
    test('returns a standard ArrayBuffer', async () => {
      const stream = createWebStream("binary");
      const result = await arrayBuffer(stream);
      expect(result instanceof ArrayBuffer).toBe(true);
      expect(new Uint8Array(result)[0]).toBe(98); // 'b'
    });
  });

  describe('blob()', () => {
    test('returns a Blob object', async () => {
      const stream = createWebStream("blobby");
      const result = await blob(stream);
      expect(result instanceof Blob).toBe(true);
      expect(result.size).toBe(6);
      expect(await result.text()).toBe("blobby");
    });
  });

  describe('Edge Cases', () => {
    test('handles empty streams', async () => {
      const emptyStream = new ReadableStream({
        start(controller) { controller.close(); }
      });
      expect(await text(emptyStream)).toBe("");
      const buf = await buffer(emptyStream);
      expect(buf.length).toBe(0);
    });

    test('throws TypeError if input is not a stream/iterable', async () => {
      await expect(text(null)).rejects.toThrow(TypeError);
      await expect(text({})).rejects.toThrow();
    });
  });
});
