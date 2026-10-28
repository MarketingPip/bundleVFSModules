# NOTES-http-outgoing-buffer.md

## Target

`test-http-outgoing-buffer` (bare `new OutgoingMessage()`, `_implicitHeader`
stubbed): first `write("asd")` must return `true`, then `while (msg.write("asd"));`
must terminate with `write()` returning `false`, and `msg.outputSize >=
highwatermark` must hold. Before this lane: the loop terminated (Writable
length reached 65536) but `outputSize` read 3 — assertion failed (exit 1).
Earlier symptom history (PR #267 lane): heap OOM on pristine main (loop never
terminated, synchronous-callback era), timeout on the #267 branch.

## Real-Node behavior probed (v24.22.1, plain node)

- `OutgoingMessage` is NOT a `Writable` (`instanceof Writable: false`, no
  `_writableState`, no `_write` on the prototype; it has its own `write` and
  `_send`). Every `write()` synchronously appends to `outputData`/`outputSize`:
  21846 writes of `"asd"` → `outputSize` 65538, `writableLength` 65538,
  final return `false` at exactly `outputSize >= 65536`.
- `writableLength === outputSize` at every step for a bare message.
- Write callbacks are stored in the `outputData` entry (`{data, encoding,
  callback}`) and NEVER fire — not on a tick, not on `end()` — only on flush.
- Default HWM 65536 (both `writableHighWaterMark` and
  `getDefaultHighWaterMark()`).

## Root cause (in plain terms)

The shim's `OutgoingMessage` extends the shim's `Writable` and buffers through
`_write`. While one `_write` is in flight (its callback deferred to a microtask
by the #272 client fix), `Writable` holds every further chunk in its own
internal buffer and never calls `_write` for them — and the test loop is
synchronous, so no microtask ever runs during it. Result: `write()` returned
`false` at the right byte count (Writable length accounting worked), but
`outputData`/`outputSize` only ever saw the first chunk (3 bytes). Two
accountings that only agree when every chunk reaches `_write` synchronously —
which async callbacks make impossible.

## Fix (`src/http.js` only, `OutgoingMessage`)

Bare base-class messages (`socket === null`, `constructor === OutgoingMessage`,
not finished) bypass `Writable` in `write()`: append `{data, encoding:
"buffer", callback}` to `outputData` synchronously, bump `outputSize`, return
`outputSize < writableHighWaterMark` (falling back to
`getDefaultHighWaterMark(false)`). The callback is stored, never fired —
matching the probe. `end()` still routes its chunk through `Writable` →
base `_write` (which appends), so no double count: each chunk takes exactly
one path, since the sync path never enters `Writable` state. Write-after-end
falls through to `super.write` so `Writable` raises its normal error.

Bare instances also get an own `writableLength` getter returning `outputSize`
(constructor, `new.target === OutgoingMessage` only): without it,
`test-http-outgoing-properties` failed at `write("asd") → writableLength 3`
(Writable state reads 0 under the bypass). The shadow is per-instance, so
`ServerResponse`/`ClientRequest` keep the `Writable` getter.

Deliberately NOT touched, and why:

- Pipelined `ServerResponse`s (`socket === null` while queued) keep the
  `Writable` path: they rely on `writableNeedDrain`/drain timing from
  `Writable` state (`test-http-outgoing-drain-writable-length`, currently
  hanging at 124 on base too — separate lane, untouched).
- `ClientRequest` pre-connect buffering keeps the `_write` path (#272:
  2KB at HWM 512 must return `false` via deferred callback).
- `ServerResponse` streaming (`_headerFlushed`, headers+chunk coalescing,
  pending frames from #279) untouched.

## Results

- `test-http-outgoing-buffer`: 1 → 0.
- Guard battery 52 tests: 47 pass; the 5 non-zero are all explained, none a
  regression: `test-http-server-keep-alive.js` does not exist (filename
  artifact — the real `test-http-keep-alive.js` passes 0, as do
  `test-http-keep-alive-timeout.js` and `test-http-keep-alive-timeout-buffer.js`);
  `test-http-outgoing-destroy`, `-destroyed`, `-proto`, `-renderHeaders`
  exit 1 identically on pristine base (different pre-existing causes).
- Baseline hangs unchanged on branch: `test-http-outgoing-drain-writable-length`
  124, `test-http-outgoing-finish` 124, `test-http-outgoing-end-types` 124,
  `test-http-outgoing-properties` 124 (bare block now passes; hang is later,
  same as base — verified by running verbosely: no assertion output).
- Keep-alive family, chunked family, consumed-timeout (streaming),
  client-highwatermark (#272), all #254 timeout flips sampled, #266 trio,
  connect/agent-remove, multiheaders, set-trailers, nodelay, proxy,
  keep-alive-max-requests all pass on the branch.

## Known gaps left (explicit, out of scope)

- `writableLength` for bare messages reads `outputSize` (correct while
  buffered); after a future socket assignment + flush it still reads
  `outputSize`, which the flush paths reset to 0 — consistent, but `drain`
  is never emitted for bare messages (no flush machinery observes the
  bypassed writes). No test covers it.
- `writableNeedDrain` is not shadowed for bare messages (still reads
  `Writable` state, i.e. `false` under the bypass). No test asserts it on a
  bare message.
- `test-http-outgoing-drain-writable-length` (124), `-finish` (124),
  `-properties` (124, later block), `-end-types` (124), `-destroy` (1),
  `-destroyed` (1), `-proto` (1), `-renderHeaders` (1) remain failing on
  base and branch alike — separate lanes.
