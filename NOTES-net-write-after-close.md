# NOTES — net: write after handle close (lane N2-26)

Target: `test-net-socket-write-after-close` — 124 (hang, empty output) on base
and live main; 0 after this fix (isolated 2x pre-rebase, 1x post-rebase onto
main `453d2976`).

## Mechanism

Two halves, both in `src/net.js`:

1. `VirtualHandle.close()` was a literal noop (`src/net.js:1128`). The test
   calls `client._handle.close()` and then `client.write('foo')`; the write
   sailed through `_write` (`_connected` true, peer alive) into
   `_deliverToPeer` and succeeded silently, so the test's `mustCall('error')`
   never fired and the process hung until the 30 s cap.
2. `_write`/`_writev` never consulted `_handle` at all, so the second block
   (`_handle.close()` then `_handle = null`, then `write`) also delivered
   silently.

## Fix (port of Node `lib/net.js` `_writeGeneric`, node-src `:1227-1261`)

- `VirtualHandle.close()` now records `this._closed = true` and nothing else.
  No internal flow calls it (only tests do — grep confirms); `_destroy`
  nulls `_handle` instead, so the flag cannot leak into destroy flows. A
  closed handle is not a destroyed socket: the Socket keeps its peer until a
  write or destroy observes the closure.
- `_write` and `_writev`, after the existing not-connected branch and before
  `_deliverToPeer`:
  - `!this._handle` → `cb(errSocketClosed())` (Node `:1247-1250`), same
    destroy-with-error + callback shape as the not-connected branch.
  - `this._handle._closed` → the syscall error the write would hit:
    `write EBADF` on POSIX, `write EPIPE` on Windows, via `errnoError`
    with `errno: -osConstants.errno[code]` (EBADF −9, EPIPE −32).
  - `_writev` gets the same two checks so a corked batch fails as one call.

## Guards (all 0 on branch, isolated)

`socket-destroy-twice`, `connect-reset`, `write-cb-on-destroy-before-connect`,
`server-reset`, `socket-reset-twice`, `connect-immediate-destroy`,
`connect-buffer`, `bytes-written-large`, `socket-byteswritten`,
`connect-abort-controller`.

## Differential

- Base: `hidden_files/fast-sweep/net-n2-wac-base-2026-11-15.csv` (main `453d2976`)
  — 122 pass / 15 timeout / 19 fail (heavy 14-lane contention: 150/156 hit
  the 10 s phase-1 cap).
- Branch: `hidden_files/fast-sweep/net-n2-wac-branch-2026-11-15.csv`
  — 126 pass / 9 timeout / 21 fail.
- Changed lines (10, sorted): autoselectfamily-attempt-timeout-cli-option
  124→0, autoselectfamily-commandline-option 124→0, connect-memleak 124→0,
  connect-options-fd 124→0, end-close 1→124, normalize-args 0→124,
  persistent-nodelay 124→1, persistent-ref-unref 124→1,
  server-listen-handle 124→1, socket-write-after-close 124→0.
- Adjudication (isolated 60 s runs on branch): normalize-args 0 ×2 — the
  sweep 124 is contention noise, NOT a regression; end-close 1,
  persistent-nodelay 1, server-listen-handle 1 — their true NO-FIX failure
  codes (124 on base was the cap); connect-options-fd, connect-memleak,
  both autoselectfamily 0 — their true passing values (124 on base was the
  cap). **Exactly 1 flip (`test-net-socket-write-after-close` 124 → 0),
  0 regressions.**

## Ship notes

- Rebased onto main `453d2976` (docs sync #413) before shipping — clean,
  no conflicts (docs-only base).
- Footprint allowlist: `["NOTES-net-write-after-close.md", "src/net.js"]`.
