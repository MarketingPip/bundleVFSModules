# NOTES-26-triage-os.md — Node 26.13.1 re-target triage, `os`

DOCS ONLY — no `src/` changes, no shim code, no `package.json` edits.
Worktree: `~/workspace/worktrees/node26-triage-process` (detached @ `3c091022`).
Node 26 binary verified first: `~/workspace/local/node-26/bin/node --version` → `v26.13.1`.
Harness host: `node --version` → `v24.22.1`.

## Verdict: os has NO shim gap

Banked numbers (parent-verified, used as-is): os total non-pass **1** — shim-gap 0,
fails-natively 1, native-timeout 0. The single non-pass fails on real Node 26 too,
so there is nothing to fix in the shim and no lane to propose.

Export diff (`parity/drift/node26-export-diff.md:57`): `os` is in the "No change"
list — no export-surface change 24→26. Changelog cross-check
(`research_notes/node-24-to-26-drift-20261119-1722/cross-check-changelog-2026-11-19.md:46`):
`| os | — | No listed-module change found | Nothing |`. v24 baseline: os closed
7/7 (100%) on v24.20.0; the 7 vendored os tests
(`test-os.js`, `test-os-eol.js`, `test-os-fast.js`, `test-os-homedir-no-envvar.js`,
`test-os-constants-signals.js`, `test-os-userinfo-handles-getter-errors.js`,
`test-os-process-priority.js`) all still pass in the 26 baseline.

## The one non-pass: `test-os-checked-function.js` — fails-natively

- Gap entry: harness exit 1, flags `["--expose-internals"]`, native exit 1,
  class `fails-natively`.
- What the test does (26 src, `test/parallel/test-os-checked-function.js`):
  monkey-patches `internalBinding('os').getHomeDirectory` to set
  `ctx.syscall = 'foo'`, `ctx.code = 'bar'`, `ctx.message = 'baz'`, then
  requires `os` and asserts `os.homedir()` throws
  `/^A system error occurred: foo returned bar \(baz\)$/` (test:18).
- Native probe, Node 26.13.1 (oracle invocation: binary, cwd
  `~/workspace/local/node-26-src`, `--expose-internals` from the test's
  `// Flags:` header): **exit 1** —
  `AssertionError [ERR_ASSERTION]: Missing expected exception.` at test:18.
  `os.homedir()` does not throw despite the patched binding.
- Native probe, host v24.22.1, same invocation: **exit 1**, identical
  `Missing expected exception` at test:18. The failure predates Node 26.
- Test file identical 24→26 (verified by `diff` of the v24.20.0 tarball extract
  against the 26 source file). The file exists in the v24.20.0 tarball but was
  never vendored into `parity/node-test/parallel/` — so it was never in the
  v24 sweep denominator (7/7) and this is not a regression; it is a
  new-to-the-suite test that fails on real Node on both versions.
- Harness run agrees (exit 1): the test never touches the `os` shim (it
  exercises the native `internalBinding('os')` + native `os.homedir()`), so
  there is no shim behaviour to fix. Classification stands: **fails-natively,
  not a gap**.

## Families / lanes / NO-FIX

- Families: none (0 gap tests).
- Lane candidates: none (0 flips — nothing to flip).
- NO-FIX list: `test-os-checked-function.js` — fails on real Node 26.13.1 and
  real Node v24.22.1 with the same `Missing expected exception` at test:18;
  the patched-binding error path the test expects does not fire on either
  version. No shim change could make a natively-failing test pass, and no
  export-surface change exists to implement.
- New-in-26 vs pre-existing: the test file is unchanged since v24.20.0 and
  fails natively on both versions — pre-existing native failure, new to this
  suite only because the 26 baseline stages the full 26 test tree (including
  never-vendored files).
- Baseline corrections: none for os — the banked class (`fails-natively`)
  reproduces exactly in my isolated native runs on both binaries.

## Evidence

| Test | Harness exit | Native 26.13.1 exit | Native v24.22.1 exit |
|------|-------------|---------------------|----------------------|
| `test-os-checked-function.js` (`--expose-internals`) | 1 | 1 (`Missing expected exception`, test:18) | 1 (identical) |
