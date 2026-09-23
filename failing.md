# failing.md — jest status

## 2026-09-23 ~18:45 EDT — ALL PASSING ✅

The failure log below this header is STALE. It was captured **before**
commit `73e65bd` ("Fix failing jest tests from failing.md"), which fixed the
root causes:

- `package.json`: declared missing runtime deps (dns-packet, pako,
  magic-string, acorn-walk)
- `tests/buffer.test.js`: corrected expectations to match real Node v24.20.0
- `tests/util_types.test.js`: deleted (misplaced Node core-style test, not a
  jest test)

Live run on this branch after merging `origin/main` (incl. PR #64 runtime
source-map work + wasi-dep-shim) and resolving the `package.json` conflict
with the union of both sides' dependencies:

> Test Suites: **49 passed, 49 total**
> Tests:       **1694 passed, 1694 total**

Note: jest prints "did not exit one second after the test run has completed"
(an open-handle warning from one of the timer/stream suites), but the run
exits 0 and every suite passes.

The old failure log this file used to hold was captured before commit
`73e65bd` and no longer reflects reality; it's preserved in git history if
ever needed.
