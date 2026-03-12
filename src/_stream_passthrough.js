// npm install readable-stream

/*!
 * stream-passthrough-web — node:stream PassThrough for browsers & bundlers
 * MIT License. Adapted from Node.js (MIT, Joyent/contributors) and
 * Cloudflare Workers runtime (Apache-2.0, Cloudflare, Inc.)
 * Node.js parity: node:stream PassThrough @ Node 0.9.4+
 * Dependencies: readable-stream
 * Limitations: None known. readable-stream's PassThrough is a complete,
 *   spec-faithful port of Node's implementation including objectMode,
 *   highWaterMark, cork/uncork, and the full Transform event contract.
 */

/**
 * @packageDocumentation
 * Browser/bundler-compatible `PassThrough` stream, sourced from `readable-stream`.
 *
 * `PassThrough` is the simplest {@link Transform} implementation: its
 * `_transform()` step does nothing except forward every chunk from the writable
 * side to the readable side unchanged, making it useful for:
 *
 * - **Tee-ing** — attach `.on('data')` listeners mid-pipe without breaking the chain.
 * - **Buffering** — collect pushed chunks before a consumer attaches.
 * - **Boundary conversion** — bridge push-style producers to pull-style consumers.
 * - **Testing** — capture stream output in memory without a real sink.
 * - **Lazy piping** — buffer writes while the downstream destination is being prepared.
 *
 * Mirrors the export of Cloudflare Workers' `node-internal:streams_transform`
 * PassThrough slice.
 *
 * ### Inherited options (passed to constructor)
 * | Option | Type | Default | Description |
 * |---|---|---|---|
 * | `highWaterMark` | `number` | `16384` (bytes) / `16` (objects) | Buffer size before back-pressure |
 * | `objectMode` | `boolean` | `false` | Pass JS objects instead of Buffers |
 * | `readableObjectMode` | `boolean` | `false` | Object mode for readable side only |
 * | `writableObjectMode` | `boolean` | `false` | Object mode for writable side only |
 * | `readableHighWaterMark` | `number` | — | Override HWM for readable side only |
 * | `writableHighWaterMark` | `number` | — | Override HWM for writable side only |
 * | `decodeStrings` | `boolean` | `true` | Convert strings to Buffers before `_transform` |
 * | `defaultEncoding` | `string` | `'utf8'` | Encoding used when `write(string)` is called |
 * | `allowHalfOpen` | `boolean` | `true` | Keep readable open after writable ends |
 */

import { PassThrough } from 'readable-stream';

export { PassThrough };
export default PassThrough;

// --- Usage ---
//
// // 1. Mid-pipe observer — inspect bytes without breaking the pipeline
// import { PassThrough } from './stream-passthrough-web.js'
//
// let totalBytes = 0
// const observer = new PassThrough()
// observer.on('data', chunk => { totalBytes += chunk.length })
// observer.on('end',  ()    => console.log(`Total: ${totalBytes} bytes`))
//
// fetchReadableStream          // any Node Readable
//   .pipe(observer)            // tap — counts bytes
//   .pipe(responseWritable)    // continues to the real sink unmodified
//
//
// // 2. Collect stream output into a Buffer (buffering pattern)
// import { PassThrough } from './stream-passthrough-web.js'
//
// function streamToBuffer(readable) {
//   return new Promise((resolve, reject) => {
//     const pt = new PassThrough()
//     const chunks = []
//     pt.on('data',  chunk => chunks.push(chunk))
//     pt.on('end',   ()    => resolve(Buffer.concat(chunks)))
//     pt.on('error', err   => reject(err))
//     readable.pipe(pt)
//   })
// }
// const buf = await streamToBuffer(someReadable)
// console.log(buf.toString('utf8'))
//
//
// // 3. Object-mode PassThrough — pass structured records through a pipeline
// import { PassThrough } from './stream-passthrough-web.js'
//
// const records = new PassThrough({ objectMode: true })
// records.write({ id: 1, name: 'Alice' })
// records.write({ id: 2, name: 'Bob' })
// records.end()
//
// for await (const record of records) {
//   console.log(record) // → { id: 1, name: 'Alice' }  then  { id: 2, name: 'Bob' }
// }
//
//
// // 4. Edge case — lazy consumer (buffering until downstream is ready)
// import { PassThrough } from './stream-passthrough-web.js'
//
// const pt = new PassThrough()
// pt.write('chunk written before consumer attached\n')
// pt.write('another early chunk\n')
//
// // Consumer attaches 500 ms later — buffered chunks are not lost
// setTimeout(() => {
//   pt.on('data', chunk => process.stdout.write(chunk))
//   pt.end()
// }, 500)
//
//
// // 5. Edge case — back-pressure (highWaterMark exceeded)
// import { PassThrough } from './stream-passthrough-web.js'
//
// const pt = new PassThrough({ highWaterMark: 8 }) // tiny 8-byte buffer
// let ok = true
// while (ok) ok = pt.write('x'.repeat(4))
// // ok === false → back-pressure signal; wait for 'drain' before writing more
// pt.once('drain', () => {
//   console.log('drained — safe to write again')
//   pt.end()
// })
// pt.resume() // consume to trigger drain
