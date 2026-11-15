# NOTES-vm-cached-data.md — Lane 10, wave V1 (cachedData real-V8 acceptance)

## Target
`test-vm-cached-data.js` — 1 test. Base (main `379e84bf`): exit 1
(`assert(!script.cachedDataRejected)` at :52). Native: exit 0.

## Mechanism
The test's `produce()` spawns a REAL Node child producing real V8 cache
bytes (568 bytes) and the shim consumes them. `cachedDataMatches`
(src/vm.js:1486) only accepted the shim's own 16-byte `VMCD` synthetic
marker, so it rejected genuine V8 bytes.

Real V8 cache header (probed with real Node v24.22.1, before the fix):
- bytes 0–7: magic `89 06 de c0 fa 8c 33 dc`
- bytes 8–11: source length as LE uint32 (44 for a 44-char source, 42 for
  a 42-char source)
- bytes 20–23: payload length (536 = 568 − 32)
- the FULL source text is NOT embedded verbatim (only string constants
  such as the function name are — "original" at offset 165), so the
  triage's "embedded source text" check is not available as a full-text
  search.

## Fix (src/vm.js only)
`cachedDataMatches` gains a V8-magic branch before the VMCD check: if the
bytes start with the 8-byte V8 magic, accept iff the LE uint32 at offset 8
equals the source length. This decides all three cases in the test
deterministically:
- right source: magic + length match → accepted;
- wrong source (`invalid` cache vs `invalid_1` source): lengths differ
  (42 vs 46) → rejected;
- sliced-by-4 cache: the magic is broken → rejected.

`ponytail:` comment on the magic constant names the ceiling: a wrong
source of the SAME length is not distinguished (V8 stores an internal
source hash at offset 12/16 that the shim does not replicate); no vendored
test covers that shape. In a browser real V8 bytes never occur (the shim
produces synthetic `VMCD` bytes) — this lane is harness fidelity, not
product behavior.

## Verification (per the lane's verification rule: repeated FULL-FILE runs,
not isolated case probes)
- zz probe (deleted after use): right-source rejected false, wrong-source
  rejected true, sliced-by-4 rejected true, VMCD synthetic rejected for a
  different source true — all correct under the shim.
- `test-vm-cached-data.js` full-file isolated runs on the branch: 5/5 exit
  0, empty stderr each time.
- Guards (base → branch): `test-vm-createcacheddata` 0 → 0,
  `test-vm-api-handles-getter-errors` 0 → 0,
  `test-vm-script-after-evaluate` 1 → 1 (same signature, pre-existing),
  `test-vm-basic` 1 → 1 (same signature, pre-existing),
  `test-vm-module-errors` 1 → 1, `test-vm-options-validation` 1 → 1.
- 0 regressions.

## Ship
- PR #___ (filled at ship time)
- Merge SHA: ___ (filled at ship time)
