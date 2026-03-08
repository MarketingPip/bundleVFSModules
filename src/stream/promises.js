// npm install readable-stream  (via ../stream)

/*!
 * stream-web/promises — node:stream/promises for browsers & bundlers
 * MIT License.
 * Node.js parity: node:stream/promises @ Node 15.0.0+
 * Dependencies: readable-stream (via ../stream)
 * Limitations:
 *   - pipeline() does not support the `end` option on individual streams
 *     (readable-stream limitation in browser context).
 *   - finished() 'cleanup' option (Node 18.0) is not supported.
 */

/**
 * @packageDocumentation
 * Implements `node:stream/promises` by wrapping `../stream`'s callback-style
 * `pipeline` and `finished` in AbortSignal-aware Promises.
 *
 * Exports:
 *   - {@link pipeline} — promise-returning multi-stream pipeline
 *   - {@link finished} — promise that resolves/rejects when a stream closes
 */

import stream from '../stream';

const { pipeline: _pipeline, finished: _finished } = stream;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds an AbortError matching Node's shape for stream abort events.
 * @param {AbortSignal} signal
 * @returns {Error & { code: 'ABORT_ERR' }}
 */
const abortError = signal =>
  Object.assign(
    signal.reason instanceof Error
      ? signal.reason
      : new Error('The operation was aborted'),
    { code: 'ABORT_ERR', name: 'AbortError' },
  );

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

/**
 * Pipes a sequence of streams together, destroying all of them if any emits
 * an error. Returns a Promise that resolves when the pipeline completes or
 * rejects on the first error.
 *
 * Optionally accepts `{ signal }` as the last argument to support cancellation.
 *
 * @param {...(stream.Readable | stream.Writable | stream.Transform | { signal?: AbortSignal })} streams
 *   Pass 2+ streams, with an optional options object `{ signal? }` as the final argument.
 * @returns {Promise<void>}
 *
 * @example
 * // Basic two-stream pipeline
 * await pipeline(readable, writable);
 *
 * // Transform in the middle
 * await pipeline(readable, transformA, transformB, writable);
 *
 * // Cancellable
 * const ac = new AbortController();
 * setTimeout(() => ac.abort(), 500);
 * await pipeline(readable, writable, { signal: ac.signal });
 */
export function pipeline(...streams) {
  // Peel off a trailing options object { signal? } if present.
  let opts = {};
  if (
    streams.length > 1 &&
    streams[streams.length - 1] !== null &&
    typeof streams[streams.length - 1] === 'object' &&
    typeof streams[streams.length - 1].pipe !== 'function' &&
    !streams[streams.length - 1]._readableState &&
    !streams[streams.length - 1]._writableState
  ) {
    opts = streams.pop();
  }

  const { signal } = opts;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));

    // readable-stream's pipeline accepts a callback as the last argument.
    const pipelineArgs = [...streams, err => {
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    }];

    _pipeline(...pipelineArgs);

    // Wire abort: destroy the first stream in the pipeline (propagates to rest).
    function onAbort() {
      const err = abortError(signal);
      // Destroy the source (index 0) — pipeline propagates destruction downstream.
      const source = streams[0];
      if (typeof source.destroy === 'function') source.destroy(err);
      reject(err);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// finished
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FinishedOptions
 * @property {AbortSignal} [signal]    - Cancel the listener.
 * @property {boolean}     [readable]  - Wait for the readable side to finish (default: true if applicable).
 * @property {boolean}     [writable]  - Wait for the writable side to finish (default: true if applicable).
 * @property {boolean}     [error]     - If false, an 'error' event does NOT reject (default: true).
 */

/**
 * Returns a Promise that resolves when the stream is fully finished (no more
 * data to consume / all data has been flushed), or rejects on error or premature close.
 *
 * Works with Readable, Writable, Duplex, and Transform streams from `../stream`.
 *
 * @param {stream.Stream} readable - Any stream.
 * @param {FinishedOptions} [options]
 * @returns {Promise<void>}
 *
 * @example
 * // Wait for a writable to drain
 * await finished(writable);
 *
 * // Only care about the writable side of a Duplex
 * await finished(duplex, { readable: false });
 *
 * // Cancellable watcher
 * const ac = new AbortController();
 * const p = finished(readable, { signal: ac.signal });
 * ac.abort();  // → p rejects with { code: 'ABORT_ERR' }
 */
export function finished(readable, options = {}) {
  const { signal, ...finishedOpts } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));

    // _finished returns an unsubscribe function.
    const unsub = _finished(readable, finishedOpts, err => {
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    });

    function onAbort() {
      unsub?.();
      reject(abortError(signal));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export default { pipeline, finished };

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import { pipeline, finished } from './stream/promises';
// import { Readable, Writable, Transform } from '../stream';
//
// // Basic pipeline — resolve when writable closes
// const src  = Readable.from(['hello', ' ', 'world']);
// const sink = new Writable({ write(c, _, cb) { process.stdout.write(c); cb(); } });
// await pipeline(src, sink);
//
// // Pipeline with a Transform
// const upper = new Transform({
//   transform(chunk, _, cb) { cb(null, chunk.toString().toUpperCase()); }
// });
// await pipeline(Readable.from(['hello']), upper, sink);
//
// // Cancellable pipeline
// const ac = new AbortController();
// setTimeout(() => ac.abort(), 100);
// try {
//   await pipeline(infiniteReadable, sink, { signal: ac.signal });
// } catch (e) { console.log(e.code); } // 'ABORT_ERR'
//
// // finished — wait for a writable to drain
// sink.write('data');
// sink.end();
// await finished(sink);
// console.log('writable fully drained');
//
// // finished — only watch writable side of a Duplex
// await finished(duplex, { readable: false });
//
// // Edge: stream already destroyed before finished() is called
// const dead = new Readable({ read() {} });
// dead.destroy(new Error('boom'));
// await finished(dead).catch(e => console.log(e.message)); // 'boom'
