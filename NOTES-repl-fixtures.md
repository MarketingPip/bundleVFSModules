# NOTES-repl-fixtures — R0 fixtures lane (wave R)

## Triage

Repl triage 2026-11-18 (`hidden_files/triage-repl-2026-11-18.md`): true
**80/102** (recorded 78/102 stale by +2). Ceiling **100/102** (99 without
the mode harness gate). The single biggest gap class is vendored fixtures:
the repo's `parity/node-test/fixtures/` held 410 files vs 4,546 in the
Node v24.20.0 tarball, and **ALL repl fixtures were missing** — 13 of the
23 triage failures fail identically natively for that reason.

## Fix (no src/ change — Z1 pattern)

Vendored 25 files verbatim from the SHA256-verified Node v24.20.0 tarball
(`hidden_files/node-src/node-v24.20.0.tar.gz`, `test/fixtures/` inside):

- `is-object.js`, `repl-load-multiline.js`,
  `repl-load-multiline-no-trailing-newline.js`, `repl-pretty-stack.js`,
  `repl-tab-completion-nested-repls.js`, `external-repl-module.js`
- `node_modules/@nodejsscope/index.js`,
  `node_modules/@nodejsscope/pkg/index.js`,
  `node_modules/baz/index.js`, `node_modules/baz/node_modules/asdf.js`
- `test-repl-tab-completion/.hiddenfiles`, `hellorandom.txt`,
  `helloworld.js`
- `.node_repl_history` (40 bytes: `'you look fabulous today'` /
  `'Stay Fresh~'`), `.empty-hidden-repl-history-file`,
  `.empty-repl-history-file`, `old-repl-history-file-faulty.json`,
  `old-repl-history-file-obj.json`
- `.node_repl_history_multiline` (278 bytes) — found during
  verification: the triage list missed it. A sweep run had created a
  0-byte placeholder at that path (test side effect); replaced with the
  real tarball content, byte-identical via `cmp`.
  test-repl-load-multiline-from-history passes [0,0] with it.
- `b/c.js`, `b/d.js`, `b/package/index.js`
- `self_ref_module/index.js`, `self_ref_module/package.json`
- `repl-folder-extensions/foo.js/index.js`

Extraction: `tar --no-same-owner -xzf` into a fresh scratch dir (the Z1
chown-EPERM quirk), then `cp -a` into `parity/node-test/fixtures/`.
Every file verified byte-identical to the tarball with `cmp`
(zero diffs; `cp -a` ownership warnings are cosmetic — the sandbox
blocks chown, contents are identical). The directories contain exactly
the listed files, no extras.

## Verification (branch head, `PARITY_TARGET=repl`)

9 fixture-only flips, 2× isolated, all [0,0]:
test-repl-load-multiline, test-repl-load-multiline-no-trailing-newline,
test-repl-pretty-stack, test-repl-pretty-custom-stack,
test-repl-require-context, test-repl-tab-complete-nested-repls,
test-repl-require-self-referential, test-repl-persistent-history,
test-repl-tab-complete-files.

### Triage correction — programmatic-history ×2 do NOT flip (shim gap)

The triage classified test-repl-programmatic-history and
test-repl-programmatic-history-setup-history as fixture-only certain
(they failed with ENOENT on the missing `.node_repl_history`). That was
wrong: the ENOENT masked a shim gap. With the fixture vendored, both
tests pass NATIVELY (exit 0) but still fail under the shim [1,1] — first
failure "Failed test # 1", `assert.strictEqual(expected.length, 0)` with
actual 2. The missing output is the "Persistent history support disabled"
message for the `NODE_REPL_HISTORY: ""` case.
Probe-proven: the shim's `setupHistory` (`src/repl.js:771-778`) is a stub
— it calls back `(null, this)` on a resolved promise and never reads the
history file, never emits the disabled message, never emits the
"Could not open history file" message. These two tests need a real
`setupHistory` port (Node `lib/repl.js` setupHistory + HistoryManager) —
a src/repl.js lane, out of scope for this fixtures-only lane. The fixture
half is done here; the shim half is owed by a follow-up lane.

Fixture halves that do NOT flip yet (shim half still owed by later lanes):
- test-repl-require — still fails; `baz` fixture present, but the
  positional-stream drop in `repl.start()` (R2) remains.
- test-repl.js (no dash) — still fails; `fixtures/b/` present, but the
  same positional-stream drop (R2) remains.
- test-repl-tab-complete-import — still fails; `@nodejsscope` fixture
  present, but the completion overhaul (R3) + harness gate (R5) remain.
- test-repl-tab-complete-require — still fails; same as import.

Guards (all exit 0): test-repl-context, test-repl-history-navigation,
test-repl-autocomplete, test-repl-inspector, test-repl-domain.

Full differential (`fast-sweep --target repl --force --jobs 2`, fresh CSV
`repl-sweep-2026-11-18-r0.csv`): branch 89/101 pass (vs 79 triage), 1
timeout (envvars, unchanged), 11 fail. Diff vs triage base: 10 flips
1→0 — the 9 above + test-repl-reverse-search (the triage-adjudicated
sweep flake, now passing in-sweep too). **0 regressions.** Footprint
test green (branch touches only `parity/node-test/fixtures/` + this
NOTES file).

## Ship

- PR #___ / merge SHA: ___ (fill at ship time)
- Repl: 80 → 89/102 (9 flips; the 2 programmatic-history tests are owed
  to a setupHistory-port lane).
