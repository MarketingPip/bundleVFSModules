# Node 26 export-surface diff (v24.20.0 → v26.13.1)

Generated 2026-11-19 by `parity/drift/export-diff.mjs`
(`--node24` v24.20.0, `--node26` v26.13.1).

Method: for each of the 28 program modules, the export surface was dumped from
real Node on both versions (probe `parity/drift/dump-exports.mjs`, reusing the
repo oracle test's method — `tests/oracle-export-surface.test.js`: own
property names incl. getters, typeof/name/arity per export, one level into
plain-object sub-namespaces such as `fs.promises`). The diff is presence +
describeValue per top-level export.

What this catches: added/removed exports, type/name/arity changes,
sub-namespace additions. What it CANNOT catch: behaviour changes with no
surface change (error codes, validation order, defaults), prototype-method
changes inside classes, and anything behind a flag. Those need the baseline
(`parity/drift/node26-baseline.jsonc`) and the drift research
(`~/workspace/research_notes/node-24-to-26-drift-20261119-1722/report.md`).

## Totals

| module | added | removed | changed | sub-added | sub-removed |
| --- | ---: | ---: | ---: | ---: | ---: |
| assert | 0 | 1 | 12 | 0 | 0 |
| async_hooks | 0 | 0 | 0 | 0 | 0 |
| buffer | 1 | 1 | 0 | 0 | 0 |
| console | 0 | 0 | 0 | 0 | 0 |
| crypto | 3 | 0 | 1 | 0 | 0 |
| dns | 0 | 0 | 0 | 0 | 0 |
| events | 0 | 0 | 0 | 0 | 0 |
| fs | 1 | 4 | 1 | 0 | 0 |
| http | 4 | 0 | 0 | 0 | 0 |
| http2 | 0 | 0 | 0 | 0 | 0 |
| https | 0 | 0 | 0 | 0 | 0 |
| inspector | 0 | 0 | 0 | 0 | 0 |
| module | 0 | 1 | 0 | 0 | 0 |
| net | 1 | 0 | 0 | 0 | 0 |
| os | 0 | 0 | 0 | 0 | 0 |
| perf_hooks | 2 | 0 | 0 | 0 | 0 |
| process | 1 | 0 | 0 | 0 | 0 |
| readline | 0 | 0 | 0 | 0 | 0 |
| repl | 0 | 0 | 0 | 0 | 0 |
| stream | 0 | 0 | 0 | 0 | 0 |
| string_decoder | 0 | 0 | 0 | 0 | 0 |
| timers | 0 | 0 | 0 | 0 | 0 |
| trace_events | 0 | 0 | 0 | 0 | 0 |
| tty | 0 | 0 | 0 | 0 | 0 |
| util | 4 | 0 | 0 | 0 | 0 |
| vm | 0 | 0 | 0 | 0 | 0 |
| worker_threads | 0 | 0 | 0 | 0 | 0 |
| zlib | 8 | 0 | 0 | 0 | 0 |

**Total: 25 added, 7 removed, 14 changed, 0 sub-added, 0 sub-removed across 28 modules.**

## No change

`async_hooks`, `console`, `dns`, `events`, `http2`, `https`, `inspector`, `os`, `readline`, `repl`, `stream`, `string_decoder`, `timers`, `trace_events`, `tty`, `vm`, `worker_threads`

## assert

Removed: `CallTracker`

Changed:
- `deepEqual`: `function:deepEqual:3` → `function:deepEqual:2`
- `deepStrictEqual`: `function:deepStrictEqual:3` → `function:deepStrictEqual:2`
- `doesNotMatch`: `function:doesNotMatch:3` → `function:doesNotMatch:2`
- `equal`: `function:equal:3` → `function:equal:2`
- `fail`: `function:fail:5` → `function:fail:1`
- `match`: `function:match:3` → `function:match:2`
- `notDeepEqual`: `function:notDeepEqual:3` → `function:notDeepEqual:2`
- `notDeepStrictEqual`: `function:notDeepStrictEqual:3` → `function:notDeepStrictEqual:2`
- `notEqual`: `function:notEqual:3` → `function:notEqual:2`
- `notStrictEqual`: `function:notStrictEqual:3` → `function:notStrictEqual:2`
- `partialDeepStrictEqual`: `function:partialDeepStrictEqual:3` → `function:partialDeepStrictEqual:2`
- `strictEqual`: `function:strictEqual:3` → `function:strictEqual:2`

## buffer

Added: `isLatin1`

Removed: `SlowBuffer`

## crypto

Added: `createMac`, `getMacs`, `parsePKCS12`

Changed:
- `getCipherInfo`: `function:getCipherInfo:2` → `function:getCipherInfo:1`

## fs

Added: `openAsBlobSync`

Removed: `F_OK`, `R_OK`, `W_OK`, `X_OK`

Changed:
- `Stats`: `function:deprecated:14` → `function:deprecated:18`

## http

Added: `isValidHeaderName`, `isValidHeaderValue`, `websocketMask`, `websocketUnmask`

## module

Removed: `_debug`

## net

Added: `_TransferredBoundSocket`

## perf_hooks

Added: `createSlidingWindowHistogram`, `importHistogram`

## process

Added: `addUncaughtExceptionCaptureCallback`

## util

Added: `debounce`, `isPartialDeepStrictEqual`, `markPromiseAsHandled`, `throttle`

## zlib

Added: `ZipBuffer`, `ZipEntry`, `ZipFile`, `createZipArchive`, `createZipArchiveSync`, `getMaxZipContentSize`, `setMaxZipContentSize`, `zipFiles`

