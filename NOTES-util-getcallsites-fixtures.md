# NOTES — util getcallsites fixtures (U1)

## What

Vendored 4 test fixtures verbatim from the SHA256-verified Node v24.20.0
tarball (`hidden_files/node-src/node-v24.20.0.tar.gz`), `cmp`-verified
byte-identical after copying. No `src/` change — the shim already implements
`getCallSites()` correctly (`src/util.js:6088`); only the fixtures were
missing, so the tests' `spawnSync(process.execPath, …)` blocks threw
`MODULE_NOT_FOUND` in the spawned native child.

## Files

- `parity/node-test/fixtures/typescript/ts/test-get-callsites.ts` (160 B)
- `parity/node-test/fixtures/typescript/ts/test-get-callsites-explicit.ts` (180 B)
- `parity/node-test/fixtures/source-map/get-call-sites-mapped.js` (161 B)
- `parity/node-test/fixtures/source-map/get-call-sites-mapped.map` (101 B)

No accompanying `get-call-sites-original.js` is needed: the `.map` only names
it in its `sources` entry (`"sources": ["get-call-sites-original.js"]`, no
`sourcesContent`); the remapped `scriptName` comes from that name.

## Mechanism (per triage `triage-util-2026-11-18.md` §1–2)

- `test-util-getcallsites.js`: all in-process `getCallSites()` blocks passed
  under the shim; only the three `spawnSync` blocks failed (test:154
  `--experimental-transform-types`, expects `lineNumber: 8`; test:167
  `--no-enable-source-maps`, expects `lineNumber: 2`; test:185 explicit file,
  expects `lineNumber: 2`).
- `test-util-getcallsites-sourcemap.js`: the in-process block (test:9-19)
  passed; the `spawnSync` blocks (test:25, 44) failed at test:30
  (`status 1 !== 0`) on the missing mapped fixture.

## Verification (branch head, worktree `util-u1-getcallsites-fixtures`)

- Flips 2× isolated, shim AND native, exit 0:
  `test-util-getcallsites.js` 0,0 (shim) / 0,0 (native);
  `test-util-getcallsites-sourcemap.js` 0,0 (shim) / 0,0 (native).
- Guards: `test-util-inspect.js` still exit 1, first failure unchanged at
  test:1636 (separate sub-gaps, lanes U2/U3); `test-util.js` 0;
  `test-util-convert-signal-to-exit-code.mjs` 0;
  `test-util-promisify-custom-names.mjs` 0.
- Full util differential (`util-u1-branch-2026-11-18.csv`) vs triage sweep
  (`util-sweep-2026-11-18.csv`, base `2de10fc4`): exactly 2 flips
  (the getcallsites pair 1→0), 0 regressions; 27/28 glob pass.
- Footprint test `tests/ondemand-require.test.js`: 29/29.
- Count: banked 28/31 + 2 flips − 0 regressions = **30/31**.

## Ship

- PR #483 / merge SHA 82257ac4 (squash-merged 2026-11-18)
