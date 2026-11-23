# NOTES-26-gate-step1 — build-time TARGET_NODE gate + the 9 datum cases

Step 1 of the version-support strategy (`~/workspace/goals/
node-parity-sweep-bundlevfsmodules-runtime/hidden_files/
version-support-strategy.md`, decided 2026-11-23): a build-time
`TARGET_NODE` gate (Node 26 default) + a version table, with the 9
(a) datum cases gated. One PR, no docs-number changes (measured-rates /
HITLIST banking follows as a separate docs sync after merge).

## Gate mechanism

`src/version-gate.js` exports `TARGET_NODE` / `isTarget24` /
`isTarget26`. Resolution order:

1. **Build-time bake** — esbuild `define: { __TARGET_NODE__: '"26"' }`
   in `src/build-vfs.mjs` `bundleToString` (validated at build time;
   invalid `TARGET_NODE` throws). The define replaces the free
   identifier, so dist carries the target as a folded constant and the
   env branch is dead code eliminated by minify. `TARGET_NODE=24`
   builds the v24 dist; default is 26.
2. **Harness override** — under the parity harness src/ runs directly
   on a Node host (no define), so the gate reads
   `process.env.PARITY_TARGET_NODE` per run. Measurement only: dist
   never reads it (verified: `PARITY_TARGET_NODE` absent from every
   dist bundle), and there is no runtime version switcher (AGENTS.md
   rule 11).
3. **Default `'26'`**. An unrecognised env value throws at import.

Verified by building dist both ways: 26-build `dist/net.js` returns
500 from `getDefaultAutoSelectFamilyAttemptTimeout()` vs 250 from the
24-build; `'Decapsulation failed'` present in the 26 crypto bundle,
absent in the 24 one; the perf_hooks delete-gate present in the 24
bundle, absent in the 26 one; util 24 vs 26 bundles differ exactly at
parseEnv prototype + detached-DataView indent; http 24 bundle has one
extra `Buffer.alloc(0)` (the trailing write). (Full-build note: the
24 build's `esm-sh-plugin` fetch of esm.sh/acorn failed transiently
twice while the 26 build succeeded — environmental, unrelated to the
gate; util/http 24 bundles were verified with a single-module rebuild
using the same `bundleToString` options + plugins.)

`src/version-table.js` — 86 entries: 40 behaviour (55 set files
grouped: rmdir 7→1, DEP0198 3→1, GC-close 2→1, detached-buffer 2→1,
classic-stream 5→1, fail() 2→1) + 46 export (25 added, 7 removed,
14 changed — generated from the drift JSONs, not hand-transcribed).
7 entries `gated` (the 9 datum cases), 5 `expected-failure` (the
OpenSSL crypto cases), the rest `pending`. The table is data only:
no code reads it to decide behaviour.

## The 9 datum cases (all gated, v24 suite only — node26 unchanged)

| # | Case | Site | v24 behaviour | 26 behaviour |
|---|------|------|---------------|--------------|
| 1 | net default timeout 250→500 | `src/net.js` default `isTarget24 ? 250 : 500` | 250 | 500 |
| 2 | SHAKE DEP0198 (×3 files) | `src/crypto/hashes.js` `maybeWarnShakeDefault` | shim silent (host warns once with the flag, never without — exactly v24) | shim warns once iff `--pending-deprecation` is ABSENT (host warns with the flag, so a shim warning there duplicates) |
| 3 | parseEnv null-prototype | `src/util.js` `parseEnv` | plain `{}` | null-prototype object |
| 4 | DataView indent 6→2 | `src/util.js` DataView block | Node 24 bump/read/retry sequence leaks +2 per throwing extra (byteLength + byteOffset) → 6-space props, 4-space close | value read first, no leak → 2-space props, 0-space close |
| 5 | perf_hooks 5 extra attrs | `src/perf_hooks.js` `toJSON` + `[kInspect]` | 5 keys/lines omitted | present |
| 6 | http trailing write | `src/http.js` standalone finish listener | trailing `sock.write(Buffer.alloc(0))` (mustCall 2) | single write (mustCall 1) |
| 7 | encap-decap message | `src/crypto/wrap26.js` `wrapDecapsulateSync` | `Failed to perform decapsulation` passes through | rewritten to `Decapsulation failed` |

Details worth keeping:

- **SHAKE flag path:** the v24 shake files carry `// Flags:
  --pending-deprecation`; the vendored `common/index.js` re-spawns
  the test with its flags plus the `--import` preload in execArgv,
  so the flag tests run UNDER the shim with the flag even via
  fast-sweep (which itself passes no flags). The first version of
  this gate ("warn under 24 only with the flag") DOUBLE-warned: the
  host native crypto emits DEP0198 itself when the flag is present,
  and `common.expectWarning` fails on the extra warning. The
  correct rule, verified in all four cells: the shim warns only
  when the host would NOT have warned — target 26 AND no
  `--pending-deprecation` flag. Under target 24 the host covers
  both cells exactly, so the shim stays silent.
- **DataView: gate verified, file blocked by a pre-existing gap:**
  on pristine main `test-util-inspect.js` fails AT the DataView
  assertion (2-space actual vs 6-space expected); on the branch the
  DataView assertions pass and the file fails later at line 1080
  (`testColorStyle`, regexp colouring — unrelated to this gate, a
  pre-existing failure). The datum case is gated; the file stays
  failing for an unrelated reason.
- **net pipe-connect-errors:** the branch v24 net sweep showed one
  apparent regression vs the base sweep
  (`test-net-pipe-connect-errors.js` base 0 → branch 1, cancelling
  the autoselectfamily flip in the aggregate). **Adjudicated: NOT a
  regression** — isolated 2× on branch 0,0 AND on base 0,0
  (absolute preload path, `PARITY_TARGET_NODE=24`, timeout 120).
  The sweep difference is a sweep flake (the shared-`.tmp.0`
  collision family). Net banks +1.
- **encap-decap: gate verified, file blocked by a pre-existing gap:**
  the message gate is proven behaviorally by probe (wrong-key
  decapsulation: target 24 → `Failed to perform decapsulation`,
  target 26 → `Decapsulation failed`, both
  `ERR_CRYPTO_OPERATION_FAILED`). But the FILE
  (`test-crypto-encap-decap.js`) cannot flip on either suite yet:
  it calls bare `assert(...)` 13 times and the shim's `assert`
  is not callable under the preload (`require("assert")` returns
  an object, `typeof assert: object`) — `TypeError: assert is not
  a function` at line 193, identical on pristine main (verified
  on the base worktree). That is an assert-module interop gap, a
  separate lane, not this gate. The datum case is gated; the file
  stays failing for an unrelated reason.
- **DataView:** the gate replicates Node 24's
  `formatExtraProperties` sequence per extra (bump +2, read, retry
  with `value.buffer[key]`), not a hard-coded +4 — the leak is
  derived from the throws. Non-detached DataViews render identically
  on both targets (verified by probe + both suites). The leaked
  level is restored after `reduceToSingleString`, as Node's
  `formatRaw` restores `ctx.indentationLvl` on return.
- **perf_hooks:** the 5 getters STAY under both targets (the v24
  test never reads them — grep-verified); only `toJSON()` (delete)
  and `[kInspect]` (two conditional chunks; the trailing comma lives
  in the tail chunk so the 24 output ends `responseStatus: 200` with
  no trailing comma) are gated. Residual unobserved divergence,
  noted here.
- **http:** this is the L-H test from the take-back wave
  (`test-http-server-response-standalone.js`). PR #554 restored the
  trailing write unconditionally and regressed node26; #555
  reverted it. The gate is the fix, not a re-restore.
- **NO free flips:** `test-stream-readable-needReadable.js` and
  `test-repl-reverse-search.js` already pass on live main and are
  already banked (stream 226/232, repl 100/108). Step 1 banks +0
  from them. Do NOT bank 226→227 or 100→101.

## Files (10, all footprint-allowed)

- `src/version-gate.js` (new), `src/version-table.js` (new)
- `src/build-vfs.mjs` (esbuild `define` + build-time validation)
- `src/net.js`, `src/crypto/hashes.js`, `src/crypto/wrap26.js`,
  `src/util.js`, `src/perf_hooks.js`, `src/http.js`
- `NOTES-26-gate-step1.md` (this file)

Not in this PR: `dist/` (CI bot regens), `parity/measured-rates.json`,
`parity/HITLIST.md` (docs sync follows separately), `parity/preload.mjs`
/ `parity/run.mjs` (untouched), `src/build-fs-only.mjs` /
`src/build-readline-only.mjs` (they import only plugins from
build-vfs.mjs and bundle no gated module in step 1 — a later lane
that gates fs/readline must add the define there too).

## Verification

Base (parent-verified, `c9755f65`): node26 2,374/2,814; v24 2,305/3,206.

Per-module banked counts (from `parity/measured-rates.json` @
`c9755f65`):

| module | v24 banked | node26 banked | expected v24 after | expected node26 after |
|--------|-----------|---------------|--------------------|-----------------------|
| net | 142/156 | 148/161 | 143/156 (+1) | 148/161 |
| crypto | 118/129 | 162/167 | 122/129 (+4) | 162/167 |
| util | 28/31 | 36/36 | 30/31 (+2) | 36/36 |
| perf_hooks | 14/15 | 24/31 | 15/15 (+1) | 24/31 |
| http | 388/397 | 412/422 | 389/397 (+1) | 412/422 |
| **program** | **2,305/3,206** | **2,374/2,814** | **2,314/3,206 (+9)** | **2,374/2,814** |

Differentials (CSVs under `~/workspace/goals/
node-parity-sweep-bundlevfsmodules-runtime/hidden_files/gate-step1/`):

- v24 side: fast-sweep `--jobs 2`, `PARITY_TARGET_NODE=24`
  (`v24-{net,crypto,util,http}.csv`, `v24-perf-hooks.csv` via
  sweep-mjs.py, `v24-stragglers-{crypto,util,http}.csv` for the
  non-glob files: `test-crypto.js`, `test-util.js` + 2 `.mjs`,
  `test-http.js` + 1 `.mjs`).
- node26 side: Node 26 files + Node 26 `test/common/` staged per
  the isolated recipe, `PARITY_TARGET_NODE` unset (default 26),
  restored with `git restore` + `git status` clean afterwards
  (`n26-*.csv`).
- Every flip isolated 2× via `parity/run.mjs` (flag-honouring) on
  the branch, and cross-checked under the opposite target (fails
  there — proves the gate selects).
- Gate smoke probe `zz-gate-probe.js` (deleted after use): net
  default, parseEnv prototype, detached/non-detached DataView,
  perf_hooks toJSON/inspect keys — PASS under 24, 26, and no-env.
- Footprint: `tests/ondemand-require.test.js` 29/29 green.
- `node --check` clean on all 9 touched files.
- Affected jest suites: 21 suites, 295 tests, all passed — net,
  crypto, http, http-close-server, http-socket, perf_hooks,
  util-inspect-duplicates, util-inspect-grouping, util_named_exports,
  export_surface_{net,crypto,http,perf_hooks,util},
  export_surface__http_{agent,client,common,incoming,outgoing,server},
  ondemand-require (see Measured results).

### Measured results

Measured 2026-11-23 by the resume worker (branch vs base worktrees
at `c9755f65`; CSVs under `~/workspace/goals/
node-parity-sweep-bundlevfsmodules-runtime/hidden_files/gate-step1/`).

**Correction to the expectation table above:** it was written
before measurement. Measured is crypto +3 (not +4), util +1 (not
+2), http +0 (not +1), program **+6 (not +9)**. The two
gated-but-blocked files (encap-decap, DataView-inspect) do not flip
— see below.

**v24** (`PARITY_TARGET_NODE=24`, `--jobs 2`):

| module | base | branch | delta |
|--------|------|--------|-------|
| net | 142/156 | 143/156 | +1 |
| crypto | 118/129 | 121/129 | +3 |
| util | 28/31 | 29/31 | +1 |
| perf_hooks | 14/15 | 15/15 | +1 |
| http | 388/397 | 388/397 | +0 |
| **program** | **2,305/3,206** | **2,311/3,206** | **+6** |

Flips (each isolated 2× 0,0 on the branch under target 24, exit 1
under target 26 — mutually exclusive):

- net: `test-net-autoselectfamily-attempt-timeout-default-value.js`
- crypto: `test-crypto-default-shake-lengths.js`,
  `test-crypto-default-shake-lengths-oneshot.js`,
  `test-crypto-hash.js`
- util: `test-util-parse-env.js`
- perf_hooks: `test-perf-hooks-resourcetiming.js`
- http: `test-http-server-response-standalone.js`

Adjudications (v24):

- net pipe-connect-errors: sweep showed base 0 → branch 1;
  isolated 2× on branch 0,0 AND on base 0,0 — sweep flake, NOT a
  regression.
- http drop-connections-in-cluster: isolated 2× on branch 124,124
  AND on base 124,124 — the banked pass (recorded by the #550
  re-baseline reconciliation) does not reproduce. The standalone
  flip (+1) offsets it, so http is +0 vs banked. Base http glob is
  387/397 + 2/2 extras; branch glob is 388/397.
- crypto SHAKE re-proof: the branch crypto sweep is unstable —
  r1 119/129 (SHAKE files fail, no tmpdir — parallel/load flake),
  r2 and r3 byte-identical at 121/129 with exactly the 3 flips vs
  base. Isolated 2×: branch 0,0 on all three files; base 1,1 on
  all three. **+3 banks.**
- util outside-glob: `test-util.js`,
  `test-util-convert-signal-to-exit-code.mjs`,
  `test-util-promisify-custom-names.mjs` — 3/3 on branch AND base
  via sweep-mjs. The +1 is parse-env only.
- net throttle / write-fully-async-buffer / write-fully-async-
  hex-string exit swaps (124↔137): both non-pass on both sides, no
  count effect; the known architectural NO-FIX (sync transport has
  no backpressure).
- Gated-but-blocked (gate proven, file stays failing for unrelated
  reasons): encap-decap (shim `assert` not callable, pre-existing,
  identical on base — assert-module interop gap, separate lane);
  DataView-inspect (branch passes the DataView assertions, fails
  later at line 1080 `testColorStyle` regexp colouring,
  pre-existing).

**node26** (default target 26; Node 26 files + Node 26
`test/common/` + Node 26 `test/fixtures/` staged, run-baseline
parity; 817 files):

| module | base | branch | banked |
|--------|------|--------|--------|
| net | 148/161 | 148/161 | 148/161 |
| crypto | 162/167 | 162/167 | 162/167 |
| util | 36/36 | 36/36 | 36/36 |
| perf_hooks | 24/31 | 24/31 | 24/31 |
| http | 412/422 | 412/422 | 412/422 |

**Node 26 stays 2,374/2,814 — zero regressions, zero flips.**
Branch-vs-base per-file: crypto/util/perf_hooks/http
byte-identical; net differs only by
write-fully-async-hex-string 124 vs 137 (both non-pass, the known
NO-FIX).

Fixture finding (diagnosed, not a code regression): the first n26
runs staged files + `common/` only (no fixtures) and understated
BOTH sides equally (crypto 159, util 35, perf_hooks 23; branch
net 147, http 413). Five files need Node 26-only fixtures:
mac-vectors → `fixtures/crypto/kmac.js`; rsa-multiprime-jwk →
`fixtures/keys/rsa_private_2048_3_primes.pem`; x509-name-non-string
→ `fixtures/x509-name-non-string.pem`; getcallsites-sourcemap →
`fixtures/source-map/get-call-sites-function-name-mapped.js`;
qrde-oracle → `fixtures/qrde-r-oracle.json`. With fixtures staged
all five pass on both sides and every count == banked.
`run-baseline.mjs` stages all three dirs; the lane drivers now do
the same (`stage_fixtures` in `run-n26-sweeps.sh` /
`run-n26-base.sh`). The no-fixtures CSVs are kept as
`*-nofix.csv`. The five files fail isolated 1,1 on base even with
`--expose-internals` passed explicitly (mac-vectors) — NOT a flags
artifact; the cause is the missing fixtures, proven by the
with-fixtures sweeps.

n26 flip-floppers, isolated 2× on the branch: pipe 0,0 (base 0,0);
drop-connections 124,124 (base 124,124). Both match base.

## Ship

- Branch: `fix/26-gate-step1` (local commit `42cf8aba`)
- Code SHA: `318c63b4e1d5cd6528b9dc03e7e79e49ebdb2b1b`
- PR: #558 — feat: build-time TARGET_NODE version gate + 9 datum cases (step 1)
- Merge SHA: `5094eb177e3e28c376377ebdfd95001ef78585e5` (squash, PUT; `merged: true` confirmed by direct API read; main tip verified). Second PR commit was the dist-regen bot commit `9fc4baa6` — expected.
- CI: GREEN on the code SHA (waiter poll 6: Parity completed/success + build completed/success, single complete run).
- Banking: v24 2,305 → **2,311/3,206 (+6)** — net +1 (142→143), crypto +3 (118→121), util +1 (28→29), perf_hooks +1 (14→15), http +0 (388/397, composition changed). Node 26 unchanged **2,374/2,814** — zero regressions, zero flips. Numbers banked in `parity/measured-rates.json` + `parity/HITLIST.md` by the docs-sync follow-up PR (this PR's sibling).
