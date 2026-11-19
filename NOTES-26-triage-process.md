# NOTES-26-triage-process.md — Node 26.13.1 re-target triage, `process`

DOCS ONLY — no `src/` changes, no shim code, no `package.json` edits.
Worktree: `~/workspace/worktrees/node26-triage-process` (detached @ `3c091022`).
Node 26 binary verified first: `~/workspace/local/node-26/bin/node --version` → `v26.13.1`.
Harness host: `node --version` → `v24.22.1` (same host as the v24 triage).
Node 26 source oracle: `~/workspace/local/node-26-src/` (`lib/` + `test/parallel/`).
Node 24.20.0 oracle: `~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/node-src/`
(`lib/` + SHA256-verified `node-v24.20.0.tar.gz`).

## Banked numbers (parent-verified, used as-is)

- Overall: 2,748 Node 26.13.1 tests, 2,144 pass / 575 fail / 29 timeout.
- Process: 14 total non-pass = 12 shim-gap + 1 fails-natively + 1 native-timeout (per banked oracle).
- v24 baseline (triage 2026-11-18, `hidden_files/triage-process-2026-11-18.md`): closed 92/97
  on v24.20.0 with 5 remaining (2 version-skew NO-FIX, get-builtin.mjs structural parked
  eager-load, load-env-file environmental, uncaught-exception-monitor harness parked exemption);
  L4 fixture vendoring shipped as PR #459 (`NOTES-process-fixture-vendoring.md`).

## Method

Isolated re-runs mirror `parity/drift/run-baseline.mjs` `runOne` exactly:
`PARITY_TARGET=process timeout 30 node --import <worktree>/parity/preload.mjs
parity/node-test/parallel/<test>`, with the Node 26 test file + `test/common`
staged over the vendored tree (and `test/fixtures/process-timeout/` for the
timeout tests), restored afterwards via `git checkout -- parity/node-test` +
deletion of staged-only files; `git status --porcelain -- parity/node-test`
verified empty after every batch. Native runs mirror `parity/drift/run-oracle.mjs`:
Node 26.13.1 binary, cwd `~/workspace/local/node-26-src`, the test file's
`// Flags:` header passed through (none of the 12 process gap tests has one).

Standing v24 finding (still true, re-verified by the failures below): the shim is
almost never loaded in this suite — the tests use the native global `process`
and the preload does not eagerly load the target shim (`triage-process-2026-11-18.md`,
"Harness finding"). Every failure below is therefore diagnosed against the
native global / harness / host version first, and only then against `src/process.js`.

## Families (14 tests: 12 banked shim-gap + 2 banked non-gap)

| # | Family | Tests | Class |
|---|--------|-------|-------|
| F1 | `--process-timeout` (new Node 26 C++ flag) | 5: `timeout.js`, `timeout-blocked.js`, `timeout-coverage.js`, `timeout-inspector.js`, `timeout-options.js` | NO-FIX |
| F2 | Version skew (test asserts 26 behaviour, host is v24.22.1) | 4: `versions.js`, `env-allowed-flags-are-documented.js`, `env.js`, `features.js` | NO-FIX |
| F3 | `execve` fatal-abort on host | 1: `execve-throws.js` | NO-FIX |
| F4 | Harness-parked (identity / ESM-origin) | 2: `get-builtin.mjs`, `uncaught-exception-monitor.js` | PARKED (do not re-open) |
| F5 | Repo-layout environmental | 1: `load-env-file.js` | ENVIRONMENTAL (parent decision, unchanged from v24) |
| F6 | Baseline race correction | 1: `redirect-warnings.js` | CORRECTION — not a gap |

True shim-gap after corrections: **11, not 12** (F6 removed). Lane candidates with
a non-zero flip: **none** — every gap is NO-FIX, parked, environmental, or a
correction. See "Lane candidates" below.

## F1 — `--process-timeout` (5 tests) — NO-FIX

`--process-timeout` is a new Node 26 embedder feature implemented in C++, not JS:
`node-26-src/src/node_watchdog.cc:117-122` ("--process-timeout has expired",
prints `(node:%d) Process timed out after %s (--process-timeout)` and force-exits
124), `src/node_options.cc:126` (value validation), `src/node_options.h:405-407`
(option storage). A browser shim has no process watchdog, no live libuv
handle/request introspection, and no way to force-exit a host page with code 124
and print the "Resources keeping the event loop alive" dump. The five tests
assert exactly that surface (`test-process-timeout.js:31-40` exit-124 + handle
list; `timeout-inspector.js` inspector lockout while the flag is set;
`timeout-options.js` flag-value validation; `timeout-coverage.js` V8 coverage
flush on timeout exit; `timeout-blocked.js` blocked-thread force-exit).

- Harness evidence (isolated, staged 26 tree + `fixtures/process-timeout/`):
  all five exit 1 with `/usr/bin/node: bad option: --process-timeout=…` — the
  host v24.22.1 does not know the flag, so every spawned child dies before the
  test runs (`timeout.js`/`timeout-blocked.js`: `--process-timeout=16000ms`;
  `timeout-coverage.js`: `--process-timeout=1000ms`, child status 9 expected 124;
  `timeout-inspector.js`: `--process-timeout=10m`, status 9 expected 0;
  `timeout-options.js`: `--process-timeout=600000ms`, status 9 expected 0).
- Native evidence (Node 26.13.1, cwd `node-26-src`): `timeout.js` exit 0,
  `timeout-inspector.js` exit 0, `timeout-options.js` exit 0 — the feature works
  on real 26; the harness failures are host-version skew on top of the
  impossible-in-browser feature.
- `timeout-coverage.js` fails natively, exit 1 (both oracle and my isolated run):
  `assert.strictEqual(files.length, 1)` at test:28, actual `0` — no
  `coverage-*.json` file is written when `--process-timeout` expires while the
  main thread spins. Real-Node-26 behaviour (coverage not flushed on timeout
  exit), not a shim gap. Classification: fails-natively (confirmed).
- `timeout-blocked.js` is a native flake, not a stable failure (baseline
  correction — see below): oracle 124 was the oracle's own 30 s cap; my
  isolated 300 s run 1 exited 1 (`runUntilReady` test:39, `1 !== 124` at
  test:60, blocked-worker block — the `wait-for-parent.js` grandchild exited
  status 1 with stdio swallowed, `native-blocked.log`), run 2 exited 0.
  Classification: native-flaky, not a shim gap, not a lane flip.

New in 26: all five test files are absent from the v24.20.0 tarball
(`tar tzf … | grep test-process-(timeout|execve-throws)` → no matches) and
`test-process-timeout.js` / `test-process-execve-throws.js` were confirmed
`Not found in archive` on extraction.

## F2 — Version skew (4 tests) — NO-FIX

All four fail against the **native host v24.22.1 global** (the shim never loads
in these tests), because the test asserts behaviour the host predates. They pass
natively on 26.13.1 (all four exit 0 in my native runs).

- `test-process-versions.js` — harness exit 1, `MODULE_NOT_FOUND` requiring
  `../../deps/acorn/acorn/package.json` at test:6. Pre-existing v24 cause
  (triage table: NO-FIX version skew). The vendoring-only fix cannot flip it:
  host reports undici `7.30.1` (`node -p process.versions.undici`), the
  v24.20.0 tarball's undici file says `7.29.0` (v24 triage, verified then);
  Node 26.13.1 reports undici `8.12.4`. 26 test changes vs v24 are additive
  only (`lief`/`libffi` keys, `hasOpenSSL(3)` rename) and gated on
  `process.config`/`common.hasFFI`, so they are not the failure.
- `test-process-env-allowed-flags-are-documented.js` — harness exit 1,
  `ENOENT … parity/doc/api/cli.md` at load (stack through `preload.mjs:674`).
  Pre-existing v24 cause (NO-FIX version skew: v24.20.0 doc lists 178 flags,
  host v24.22.1 has 285; residual undocumented flags
  `--enable-fips-indicator-events`, `--allow-openssl-store`). The 26 test now
  adds `--enable-fips-indicator-events` to the documented set (diff line 75)
  and FFI-flag deletions, but the doc file is missing entirely so the
  comparison never runs.
- `test-process-env.js` — NEW-in-26 failure (test changed: `process.env[42]`
  assertions added at lines 32, 50-52; v24 sweep had this test at exit 0).
  Harness exit 1, `AssertionError [ERR_ASSERTION]: Expected values to be
  loosely deep-equal` in the `structuredClone(process.env)` block
  (`assert.deepEqual(env, process.env)`): the clone (actual) lacks the `'42':
  'forty-two'` entry the live env (expected) has. Probe, decisive:
  `node-26 -e "process.env[42]='forty-two'; structuredClone(process.env)"` →
  clone has `42: true, "forty-two"`; host v24.22.1 same probe → `42: false,
  undefined`. The host's `structuredClone` drops numeric env keys; Node 26's
  keeps them. Not a shim gap — the parent and the spawned child both run on
  the native global. (The `process.env[42]` read-back itself works on both:
  both probes print `"forty-two"` before cloning.)
- `test-process-features.js` — NEW-in-26 failure (test changed: `['dtls',
  ['boolean', 'undefined']]` added at line 13; v24 sweep had this test at
  exit 0). Harness exit 1, `assert.deepStrictEqual(actualKeys, new
  Set(expectedKeys.keys()))`: the 26 test demands the exact 14-key set
  including `dtls`; the native host v24.22.1 `process.features` has no `dtls`
  key (probe: host features JSON has 13 keys, no `dtls`; Node 26.13.1 features
  JSON includes `"dtls":false`). Note for a future hygiene lane: the shim's
  fallback features (`src/process.js:936-955`) also lack `dtls` — but adding it
  would flip **0** tests here, because the shim never loads in this test. Do
  not count it as a flip.

## F3 — `execve` fatal-abort on host (1 test) — NO-FIX

`test-process-execve-throws.js` (new in 26 — absent from the v24.20.0 tarball)
expects `process.execve(nonexistent)` to throw a catchable `ENOENT` error
(test:13-27). Native Node 26.13.1 does that (my native run exit 0). Native
host v24.22.1 does not: it fatally aborts — isolated harness run exit 134,
baseline exit 129, both with `node:internal/process/per_thread:326
_execve(execPath, args, envArray); ^ process.execve failed with error code
ENOENT`; direct native host run also exit 134 with the same fatal lines.
Independently, the shim's `execve` is an intentional honest noop
(`src/process.js:828`: "no exec in a browser; noop") — `execve` cannot exist
in a browser. Two independent NO-FIX reasons; 0 flips.

## F4 — Harness-parked (2 tests) — PARKED, do not re-open as a lane

- `test-process-get-builtin.mjs` — harness exit 1, `AssertionError … Expected
  "actual" to be reference-equal to "expected"` at test:55
  (`assert.strictEqual(process.getBuiltinModule(id), require(id))`, first loop).
  Same L1 identity family as v24 (triage: mismatches start exactly at id
  `process`): `getBuiltinModule` returns the native global, `require('process')`
  loads the shim's `process2` (`src/process.js:774` delegates only to the
  `__bvm_process_final__` template, otherwise `undefined`; `:1115-1164` builds
  `processFinal` fresh without adopting `_priorGlobalProcess` own properties,
  `:44`). 26 test changes vs v24 are only deletions of unflagged builtins
  (`node:dtls`, `node:vfs`, plus the pre-existing `node:quic` deletion). Per
  task brief: the eager-load structural question stays parked — record as
  parked, 0 flips.
- `test-process-uncaught-exception-monitor.js` — harness exit 7, unchanged test
  file 24→26. Isolated log: `actual: 'unhandledRejection', expected:
  'uncaughtException'` (strictEqual). Same v24 harness exemption
  (`NOTES-process-fixture-vendoring.md`: any `node --import <ESM>` run routes
  the entry point through the ESM loader, so a top-level throw becomes a
  rejected module-evaluation promise; native run gives `uncaughtException`).
  Parked harness decision, parent's call; 0 flips.

## F5 — Repo-layout environmental (1 test) — parent decision, unchanged from v24

`test-process-load-env-file.js` — harness exit 1, unchanged test file 24→26.
Isolated log: `Error: ENOENT: no such file or directory, chdir
'…/node26-triage-process' -> '…/node26-triage-process/lib'`. Same v24 L4
residual (`NOTES-process-fixture-vendoring.md`: 5/6 subtests pass after
vendoring; the remaining "should throw when `.env` does not exist" subtest
`process.chdir(join(process.cwd(), "lib"))` needs Node's own source `lib/`,
which cannot be vendored). Needs a harness/layout decision; 0 flips.

## F6 — Baseline correction: `redirect-warnings.js` is NOT a gap

Banked as shim-gap (harness 1, native 0). Isolated re-run: exit 0. The baseline
1 is the `.tmp.0/warnings.txt` sweep race already adjudicated for its `-env`
sibling in v24 (`NOTES-process-fixture-vendoring.md`): `common/tmpdir.js` names
the tmpdir `.tmp.<TEST_THREAD_ID||0>`, fast-sweep sets no `TEST_THREAD_ID`, so
parallel tests share `.tmp.0`, and both redirect-warnings tests
`tmpdir.refresh()` + use the same filename `warnings.txt`.
Reproduced for the plain test: 3 concurrent rounds of plain + env together —
round 1: plain pass (0-byte log), env fails `ENOENT … .tmp.0/warnings.txt`;
round 2: same; round 3: plain fails with the identical ENOENT, env passes.
Correction: remove `test-process-redirect-warnings.js` from the process gap
list. (Its `-env` sibling already reads 0 in the 26 baseline.) Follow-up for
the parent, NOT a lane: fast-sweep should set a distinct `TEST_THREAD_ID` per
parallel job (already noted in v24 L4, still unaddressed).

## New-in-26 vs pre-existing split (12 banked gaps)

- Pre-existing cause (6): `versions.js`, `env-allowed-flags-are-documented.js`,
  `load-env-file.js`, `uncaught-exception-monitor.js`, `get-builtin.mjs`,
  `redirect-warnings.js` (F6 — and not a gap at all after correction).
  Of these, test files identical 24→26: `load-env-file.js`,
  `redirect-warnings.js`, `uncaught-exception-monitor.js` (verified by `diff`
  against the v24.20.0 tarball extracts); `versions.js`,
  `env-allowed-flags-are-documented.js`, `get-builtin.mjs` changed only in
  ways that are not the failure cause (see F2/F4).
- New in 26 (6): `env.js`, `features.js` (existing tests, new assertions that
  fail on host-version behaviour); `execve-throws.js`, `timeout.js`,
  `timeout-inspector.js`, `timeout-options.js` (new test files, absent from
  the v24.20.0 tarball). (`timeout-blocked.js`, `timeout-coverage.js` are the
  same new family but banked non-gap; see F1/baseline corrections.)
- Changelog cross-check (`research_notes/node-24-to-26-drift-20261119-1722/
  cross-check-changelog-2026-11-19.md:49`): 25.0.0 process `'multipleResolves'`
  event removed. No gap test covers it — no `multipleResolves` hit in any
  `test-process-*.js` in the 26 tree or in `src/process.js`. No action.
- Export diff (`parity/drift/node26-export-diff.md:115-117`): process ADDED
  `addUncaughtExceptionCaptureCallback`. Verified present on real Node 26.13.1
  (`typeof process.addUncaughtExceptionCaptureCallback` → `function`) and
  absent from `src/process.js` (grep: no hit). No gap test covers it — 0 flips
  in this set; recorded as an export-parity follow-up, not a lane here.

## Lane candidates (conservative estimated flips)

| Candidate | Scope | Tests it would flip | Est. flips |
|-----------|-------|---------------------|-----------|
| (none with ≥1 flip) | — | — | 0 |
| Hygiene: add `dtls: false` to shim fallback `features` (`src/process.js:936-955`) | 1-line, aligns shim key set with Node 26 | none in this suite (shim never loads in `features.js`) | 0 |
| Export follow-up: implement `process.addUncaughtExceptionCaptureCallback` in `src/process.js` | new-in-26 export | none in this set (no covering test) | 0 |

No lane is proposed for F1–F5: F1/F2/F3 are NO-FIX with probe evidence above,
F4 is parked by brief, F5 awaits a parent layout decision. If the harness
ever runs on a Node 26 host, F2 (4 tests) and the harness half of F1 (3 tests:
`timeout.js`, `timeout-inspector.js`, `timeout-options.js`) would need
re-triage — they would pass natively there, leaving only the
impossible-in-browser core.

## Baseline corrections

1. `test-process-redirect-warnings.js`: shim-gap → **not a gap** (sweep race,
   F6). Process true shim-gap: 12 → **11**.
2. `test-process-timeout-blocked.js`: native-timeout → **native-flaky**
   (oracle's 124 was its own 30 s cap; isolated 300 s run 1 exit 1, run 2
   exit 0). Not a shim gap; not a lane flip.
3. `test-process-timeout-coverage.js`: fails-natively **confirmed** (isolated
   native exit 1, `files.length` 0 vs 1 at test:28 — no coverage file written).
4. All other banked classes reproduced exactly in isolated runs (exits in
   "Evidence" below).

## Evidence (isolated re-runs, all quoted exits)

Harness (`PARITY_TARGET=process`, host v24.22.1, staged 26 tree):

| Test | Harness exit | Native 26.13.1 exit |
|------|-------------|---------------------|
| `test-process-env-allowed-flags-are-documented.js` | 1 (ENOENT `parity/doc/api/cli.md`) | 0 |
| `test-process-env.js` | 1 (structuredClone deepEqual, `'42'` dropped) | 0 |
| `test-process-execve-throws.js` | 134 (fatal `per_thread:326`, baseline 129) | 0 |
| `test-process-features.js` | 1 (key-set deepStrictEqual, no `dtls`) | 0 |
| `test-process-get-builtin.mjs` | 1 (reference-equal, test:55) | 0 |
| `test-process-load-env-file.js` | 1 (chdir `lib/` ENOENT) | 0 |
| `test-process-redirect-warnings.js` | 0 isolated (baseline 1 = race) | 0 |
| `test-process-timeout-blocked.js` | 1 (`bad option: --process-timeout=16000ms`) | flaky: 1 then 0 |
| `test-process-timeout-coverage.js` | 1 (`bad option: --process-timeout=1000ms`) | 1 (0 coverage files) |
| `test-process-timeout-inspector.js` | 1 (`bad option: --process-timeout=10m`) | 0 |
| `test-process-timeout-options.js` | 1 (`bad option: --process-timeout=600000ms`) | 0 |
| `test-process-timeout.js` | 1 (`bad option: --process-timeout=16000ms`) | 0 |
| `test-process-uncaught-exception-monitor.js` | 7 (origin `unhandledRejection`) | 0 |
| `test-process-versions.js` | 1 (MODULE_NOT_FOUND `deps/acorn`) | 0 |

Probes (all run this session):
- `node-26 --version` → `v26.13.1`; host `node --version` → `v24.22.1`.
- `structuredClone(process.env)` with `env[42]='forty-two'`: Node 26.13.1
  clone has `42: true`; host v24.22.1 clone has `42: false`.
- `process.features`: Node 26.13.1 includes `"dtls":false`; host v24.22.1
  has no `dtls` key.
- `process.versions.undici`: host `7.30.1`, Node 26.13.1 `8.12.4`.
- `process.execve` nonexistent path: host v24.22.1 native exit 134 (fatal
  `per_thread:326`); Node 26.13.1 exit 0 (catchable throw).
- `typeof process.addUncaughtExceptionCaptureCallback` on 26.13.1 → `function`.
- v24.20.0 tarball: `test-process-timeout*.js` (5 files) and
  `test-process-execve-throws.js` absent; `load-env-file.js`,
  `redirect-warnings.js`, `uncaught-exception-monitor.js` identical 24→26.

Worktree state at write time: `git status --porcelain -- parity/node-test`
empty after every staging batch (26 tree fully restored); only the two
NOTES docs are new. The `node_modules` symlink used for the runs was removed
before commit.
