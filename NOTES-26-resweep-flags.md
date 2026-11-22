# Node 26 full-program re-sweep (fixed drift tool honors `// Flags:`) — coordinator notes

**Base:** main `8d037677` (PR #539). **Banked:** program 2,370/2,813 (from
`parity/measured-rates.json` node26 on main — read by coordinator before
spawning; NOTE: the brief's per-module list carried v24 numbers for 6
modules — inspector 41/76 not 38/75, os 7/8 not 7/7, readline 21/22 not
22/22, timers 58/59 not 45/45, trace_events 12/13 not 28/29, tty 3/3 not
5/5; querystring is not a node26 module. The file is authoritative.)
**Method:** run-baseline.mjs (fixed) --jobs 2 per module, 6 workers, every
diff adjudicated isolated 2x. Evidence under
`hidden_files/resweep-flags/<worker>/`.

## Per-module table

| Module | Banked | Re-sweep | Diff |
|---|---|---|---|
| http2 | 94/307 | 94/289 (tool scope) | none (see note) |
| stream | 226/232 | 226/232 | none |
| crypto | 162/167 | 160/167 raw → 162/167 adjudicated | none (2 parallel flakes) |
| worker_threads | 139/147 | 138/146 raw (tool scope) → 139/147 adjudicated | none |
| repl | 100/108 | 99/108 raw → 100/108 adjudicated | none (1 flip already banked + 1 flake) |
| vm | 66/101 | 66/101 | none |
| process | 88/102 | 87/102 raw → **89/102 adjudicated** | **+1 FLIP** |
| zlib | 69/89 | 66/89 raw → 69/89 adjudicated | none (3 parallel flakes) |
| inspector | 41/76 | 41/76 | none |
| http | 412/422 | 412/422 | none |
| https | 60/70 | 60/70 | none |
| assert | 13/14 | 13/14 | none |
| async_hooks | 41/48 | 29/36 tool + 12/12 ALS → 41/48 | none |
| buffer | 71/74 | 71/74 | none |
| console | 22/22 | 22/22 | none |
| dns | 12/32 | 12/32 | none (3 genuine 124s) |
| events | 39/39 | 9/9 tool + 30/30 W4 → 39/39 | none |
| module | 37/41 | 33/37 tool + 4/4 diag → 37/41 | none |
| os | 7/8 | 7/8 | none |
| perf_hooks | 24/31 | 24/31 | none |
| readline | 21/22 | **22/22** | **+1 FLIP (flag-caused)** |
| string_decoder | 4/4 | 4/4 | none |
| timers | 58/59 | 58/59 | none |
| trace_events | 12/13 | 10/13 run 1 → 11/13 re-run → 12/13 adjudicated | none (1 load flake + 1 parallel flake) |
| tty | 3/3 | 3/3 | none |
| util | 36/36 | 36/36 | none |
| fs | 365/385 | 360/385 raw → 365/385 adjudicated | none (5 parallel flakes) |
| net | 148/161 | 148/161 | none |

## Totals (program, all 28 modules verified)
- Banked: **2,370/2,813** (84.25%).
- Re-swept (adjudicated): **2,372/2,813** (84.33%). Both round to 84.3% at
  one decimal — the headline percentage does not move.
- Arithmetic: 2,370 + 2 flips = 2,372. Per-module sum re-checked by the
  coordinator from the table above (2,372 passed / 2,813 total).

## Flips (2) — both verified isolated 2x by the worker AND 2x by the coordinator
1. `test-process-redirect-warnings.js` (process 88 → **89/102**). Banked
   fail → sweep pass, isolated [0,0] x2. No `// Flags:` header — NOT
   flag-caused; the triage had classified it "not a gap (sweep race)" and it
   now passes deterministically. A measurement correction, no code change.
2. `test-readline-promises-csi.mjs` (readline 21/22 → **22/22**). Banked
   fail → sweep pass, isolated [0,0] x2 with `--expose-internals` from its
   `// Flags:` header. **The flag-caused flip this re-sweep was designed to
   find** — the triage had classified it "not a gap (needs --expose-
   internals, harness WITH flag exits 0)"; the fixed tool now honors the
   flag. A measurement correction, no code change.
## Regressions (0)
No test that passed in the banked counts fails after adjudication. Every
sweep-only non-pass across all 28 modules passed isolated 2x (parallel
flakes) or was a known slow/marginal test (zlib zip64, net hex-string) that
never passes in any observed run.

## Recommendation
- **Bank the corrected total 2,372/2,813** via a docs sync (measured-rates
  node26: process 89/102, readline 22/22; HITLIST re-sweep note). Both flips
  are measurement corrections — neither justifies a fix lane (no code was
  changed to produce them, and there is nothing to fix: both tests pass
  under a correct harness invocation).
- **No lanes from this re-sweep.** The Flags fix changed the measurement for
  363 flagged tests and moved exactly 1 of them (readline) — the other
  flagged tests' outcomes are unchanged.
- **Follow-up (not a lane):** `test-eventemitter-asyncresource.js` exists in
  the Node 26 tree but matches no module glob — uncounted, in no banked
  total. A future Wave 4-style fold-in candidate (measure + triage, 1 file).

## http2 + stream (worker resweep-h2stream) — VERIFIED by coordinator from CSVs on disk
- http2: 94 pass / 192 fail / 3 timeout of 289 (CSV: 94x0, 192x1, 3x124).
  Denominator note: the tool runs 289 files; banked 307 = 94/289 + the 18
  diagnostics-channel tests folded in by Wave 4 (measured separately, 0 pass,
  no `// Flags:` headers — the Flags fix cannot move them). 94/289 is the
  exact comparable re-measurement. The 3 timeouts are the same 3 as the
  in-repo baseline (respond-file-error-pipe-offset, respond-file-with-pipe,
  socket-close), still 124 at 30 s.
- stream: 226/232 (CSV: 226x0, 6x1). The 6 fails are the brotli
  `test-stream-iter-transform-*` set, confirmed fail isolated 2x.
- Vs the stale in-repo baseline the only diffs are exactly the banked Wave 2
  (+17) + Wave 3 (+33 flips − 4 brotli regressions) arithmetic.
- Worktree clean after sweeps + adjudication. No load degradation.

## crypto + worker_threads + repl (worker resweep-crypto) — VERIFIED by coordinator from CSVs on disk
- crypto: raw 160/167 (CSV: 160x0, 5x1, 2x124). The 2 timeouts
  (kem-shared-key, key-reuse-concurrent) pass isolated 2x → parallel flakes.
  The 5 fails match the banked failure set. Adjudicated 162/167 = banked.
- worker_threads: raw 138/146 (CSV: 138x0, 5x1, 1x124, 1x129, 1x9 — the
  worker's "7 fail, 1 timeout" slightly misstates the exit split; the 8
  non-passes are exactly the banked failure set). The 147th banked test is
  the Wave 4 fold-in diagnostics-channel test (outside the tool glob),
  confirmed pass isolated 2x. Adjudicated 139/147 = banked. One
  host-rejected flag noted (`--experimental-web-worker` dropped, documented).
- repl: raw 99/108 (CSV: 99x0, 8x1, 1x124). test-repl-highlight.js passes
  (flip vs the stale w2/w3 verify files, already reflected in banked
  100/108 — coordinator re-ran it isolated, exit 0, confirming). 
  test-repl-history-navigation.js fails in sweep, passes isolated 2x →
  parallel flake. Other 7 fails + 1 timeout match the banked set.
  Adjudicated 100/108 = banked.
- No load degradation in any module (timeouts <1.5%).

## vm + process + zlib + inspector (worker resweep-vmproc) — VERIFIED by coordinator from CSVs on disk
- vm: 66/101 (CSV: 66x0, 34x1, 1x124). Per-test pass set byte-identical to
  banked. No diffs.
- process: raw 87/102 (CSV: 87x0, 12x1, 1x124, 1x129, 1x7 — the worker's
  "14 fail, 1 timeout" again loosely summarizes the exit split; totals
  correct). **ONE GENUINE FLIP: test-process-redirect-warnings.js, banked
  fail → sweep pass, isolated [0,0] by the worker AND [0,0] by the
  coordinator (re-run in the coord worktree).** No `// Flags:` header — the
  flip is NOT flag-caused; the triage had already classified this test "not
  a gap (sweep race)", and it now passes deterministically. The other two
  diffs are parallel flakes (exit-code-validation timeout, redirect-
  warnings-env fail — both isolated [0,0]). Adjudicated process **89/102**.
- zlib: raw 66/89 (CSV: 66x0, 20x1, 2x124, 1x9). All 3 diffs are banked-pass
  L-ZIP flips flaking in parallel (zip-property, zip-security — the known
  `.tmp.0` flake, zip64 slow/marginal: isolated [124,0,0,0], passing run
  24.3 s vs the 30 s cap). Passes stand; adjudicated 69/89 = banked serial
  count. Host rejects `--experimental-vfs` (dropped by tool, documented;
  zip-vfs keeps its before-run exit).
- inspector: 41/76 (CSV: 41x0, 29x1, 6x124). Per-test pass set byte-identical
  to banked, including the same 6-timeout set. No diffs.
- Coordinator trap note: my own isolated verify deleted the TRACKED v24
  `test-process-redirect-warnings.js` on cleanup (same name in both
  versions); restored with `git restore`, worktree verified clean.
- Worker scratch left behind (not evidence): `~/workspace/worktrees/
  adjudicate-vmproc.sh`, `~/workspace/worktrees/resweep-vmproc-common-v24-backup/`.

## http + https (worker resweep-http) — VERIFIED by coordinator from CSVs on disk
- http: 412/422 (CSV: 412x0, 6x1, 1x124, 2x129, 1x9 = 422). The 10
  non-passers are all inside the baseline's 32-fail set; the 22 now-passing
  are the documented banked flips (3 + 19 from PR #529). No diffs.
- https: 60/70 (CSV: 60x0, 7x1, 3x124). The 2 flips vs baseline
  (agent-getname, selfsigned-no-keycertsign-no-crash) are PR #515's banked
  flips, adjudicated isolated [0,0] by the worker. No diffs.
- INCIDENT (VM write block ~08:45–09:10 EST, the known seccomp flapping
  block): both sweeps had already completed cleanly when the block hit; the
  worker's isolated-adjudication attempt then gutted its worktree (3,217
  deleted, 5 truncated). Restored WITHOUT `git checkout` by hardlinking the
  full tree from sibling worktree resweep-coord (same SHA), verified 0
  mismatches across 3,718 files. Coordinator re-verified: worktree status
  shows only the node_modules symlink, `git diff` empty, HEAD 8d037677.
  Sweep evidence (CSVs above) is intact and was written before the block.
- CORRECTION to the worker's report: its claim that
  `parity/measured-rates.json` on main "has no node26 section" is WRONG —
  the coordinator read the file on main at the start of this job (28
  modules, http 412/422). The worker evidently read it from a stale/damaged
  path. Harmless here (it trusted the brief's numbers, which match the
  file), but the claim is refuted.
- Also noted: direct-from-source adjudication runs are NOT equivalent to
  staged runs (preload only shims under the worktree) — do not adjudicate
  by direct path.

## 15 small modules (worker resweep-small) — VERIFIED by coordinator from CSVs on disk
- All 15 CSVs re-summed by the coordinator; every count matches the worker's
  report. Supplementary CSVs confirm: events W4 set 30x0, module-diag 4x0,
  ALS 12x0. Worktree resweep-small: status clean (only node_modules
  symlink), diff empty.
- **ONE FLIP: test-readline-promises-csi.mjs, readline 21/22 → 22/22.**
  Banked fail, passed the sweep, isolated [0,0] by the worker AND [0,0] by
  the coordinator (re-run in the coord worktree, with `--expose-internals`
  from its `// Flags:` header). **This is the flag-caused flip the re-sweep
  was designed to find** — the triage had classified it "not a gap (needs
  --expose-internals, harness WITH flag exits 0)"; the fixed tool now honors
  the flag, so it passes in the sweep. No code change involved — a
  measurement correction.
- trace_events: run 1 read 10/13 (2 timeouts = 15% → whole-module re-run
  per the load rule). Re-run CSV confirmed by coordinator: 11x0, 1x1, 1x124
  (category-used.js passed; fs-async.js still 124 in the re-run but
  isolated [0,0] → parallel flake; get-category-enabled-buffer.js the sole
  real fail). Effective 12/13 = banked.
- dns: the 3 timeouts (cancel-reverse-lookup, channel-cancel,
  multi-channel) reproduced isolated 2x at 124/124 — genuine timeouts, not
  flakes. 12/32 stands.
- buffer: copy-immutable exit 9 is the host-rejected-flag path (documented
  behavior, not a regression).
- Tool-gap note (worker's, correct): run-baseline's events run covers only
  the 9 `test-events-*` files; the other 30 (Wave 4 set) were measured with
  the isolated recipe, same invocation the tool uses. `--modules
  event-emitter` would have been wrong (PARITY_TARGET would not be `events`).
- UNCOUNTED FILE flagged (not in any banked total, not in the 2,813
  denominator): `test-eventemitter-asyncresource.js` exists in the Node 26
  tree but matches no module glob (not events 39, not async_hooks 48).
  Follow-up for a future Wave 4-style fold-in, NOT part of this re-sweep.
- INCIDENT (VM write block ~08:52 EST): the timers run died on `git
  index.lock` EPERM; the worker's restore script then deleted 5,332 files
  (its own bug — no empty-list guard on the tracked-list removal). Recovered
  via bash-loop `git show` restores + `git checkout -- parity/node-test`
  once the block lifted. Coordinator verified the final state: worktree
  clean, diff empty, and the timers + buffer sweeps ran cleanly afterwards.
  (The worker's "net program effect 2,370 → 2,371" counts only its own
  flip; with the process flip the running total is 2,372.)
- Coordinator trap note: my own isolated verify deleted the TRACKED v24
  `test-readline-promises-csi.mjs` on cleanup (same name in both versions);
  restored with `git restore`, worktree verified clean.

## fs + net (worker resweep-fsnet) — VERIFIED by coordinator from CSVs on disk
- fs: raw 360/385 (CSV: 360x0, 24x1, 1x124). All 5 diffs are banked passes
  flaking in parallel (cp-async-async-filter-function, readfile-pipe-large,
  readfilesync-pipe-large, rm, write-reuse-callback) — each isolated [0,0]
  by the worker; the coordinator re-ran write-reuse-callback isolated
  [0,0] itself. Load context: phase 1 had 248/385 tests hit the 10 s cap
  while other lanes ran concurrently (load avg ~8); phase 2 at 30 s resolved
  all but 1 timeout (0.26% — under the whole-module re-run trigger).
  Adjudicated 365/385 = banked.
- net: 148/161 (CSV: 148x0, 10x1, 1x124, 2x129). Non-pass set identical to
  banked; the 3 Wave-fix tests still pass. hex-string changed exit only
  (129 baseline → 124 sweep → 137 OOM isolated): it loops
  `while (conn.write(data, 'hex'));` on a 1 MB buffer with no drain, memory
  grows unboundedly until the OOM killer fires — a stable fail, not a flip.
  Adjudicated 148/161 = banked.
- Worktree resweep-fsnet clean (only node_modules symlink), diff empty,
  HEAD 8d037677.

## Uncounted-file follow-up (docs sync, 2026-11-22)
- `test-eventemitter-asyncresource.js` (Node 26 tree, matches no module glob) was measured for a possible fold-in under the strict rule (oracle exit 0 AND shim exit 0 twice): oracle (native Node 26.13.1) exit 0; shim exit 1, 2x (isolated staged runs, `PARITY_TARGET=events`, Node 26 `common/`).
- Failure: `src/events.js:1865` — `EventEmitterAsyncResource` constructor calls `validateString(options?.name, "options.name")` and throws `ERR_INVALID_ARG_TYPE` when the test subclasses it without a name (`new Foo()` at test:58). Node 26 defaults the name; the shim requires it.
- **Not folded in.** Events stays 39/39, denominator stays 2,813, program total stays 2,372/2,813. This is a real shim gap and a candidate fix lane (default `options.name` in `EventEmitterAsyncResource`), not a measurement correction.
