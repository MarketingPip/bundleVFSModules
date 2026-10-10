# Worker F ("host") — runtime.js lines 4900-6327 — Checklist

NOTE: `todo.write` tool not available in this subagent session; tracking here.

## Setup
- [x] Read AGENTS.md (the `_RUNTIME_` contract)
- [x] Create branch `modular/host` from main
- [ ] Read existing `src/runtime/*` modules for conventions

## Extraction
- [x] Analyzed section: `_parseKey` is 38 lines (NOT 1080 — task brief was wrong);
      lines 5006-6061 are CodeSandbox class body (another worker's section).
      `makeOutputShim2` + `_parseKey` live INSIDE the `_getState` iframe-bootstrap
      template literal (runtime.js:4635-5005) — iframe-side code.
- [ ] Extract `makeOutputShim2()` → `src/runtime/output-shim.js`
- [ ] Extract `_parseKey()` → `src/runtime/message-handler.js`
- [ ] Extract `executeCode`, `createSandbox` → `src/runtime/entry.js`
- [ ] Extract `FormattedError`, `formatErrors`, `formatErrors2`,
      `normalizeSeaAssets`, `base64EncodeBytes`, `isSeedEnvelope`,
      `seedBytesToBase64`, `flattenFileTree` → `src/runtime/host-utils.js`
      (entry.js re-exports them; keeps entry.js importable/testable without
      the not-yet-extracted CodeSandbox class)
- [ ] All functions/classes use `export`

## Dependency analysis
- [ ] Catalog every identifier used in my section defined outside it (lines 1-4899)
- [ ] Determine parameter-injection vs import strategy per dependency
- [ ] Note suggested sub-splits for `_parseKey`

## Tests
- [x] `tests/runtime-host.test.js`: 45 tests — _parseKey (incl. template
      interpolation proof), makeOutputShim2 (globalThis-installed Writable),
      FormattedError, formatErrors/formatErrors2, normalizeSeaAssets,
      base64EncodeBytes (incl. >0x8000 chunk path), isSeedEnvelope,
      seedBytesToBase64, flattenFileTree, entry.js static wiring checks
- [x] All tests pass: `NODE_OPTIONS=--experimental-vm-modules npx --no-install jest tests/runtime-host.test.js` → 45/45
- [x] `node --check` on each new module

## Commit
- [x] Commit ONLY: src/runtime/output-shim.js, src/runtime/message-handler.js,
      src/runtime/host-utils.js, src/runtime/entry.js,
      tests/runtime-host.test.js, WORKER-F-HOST-TODO.md
- [x] runtime.js untouched (verified via git status)

## Report
- [x] Files created, test results, cross-module dependencies, _parseKey sub-splits
      → see final subagent report
