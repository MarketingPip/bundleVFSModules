# zstdify 1.4.0 — vendored (zlib Z6)

Vendored 2026-11-18 for the Zstd codec in `src/zlib.js`. Pure-JS zstd
compress/decompress (MIT, upstream: https://www.npmjs.com/package/zstdify).
Vendored instead of a package.json dependency: the repo's footprint test
(`tests/ondemand-require.test.js`) allows only `^src/`, `^parity/`,
`^NOTES-[^/]+\.md$`, `^docs/capability-matrix.json$` — `package.json` is NOT
allowed, so a dep line there would fail CI.

## Contents

31 files: the exact set reachable from `dist/compress.js` +
`dist/decompress.js` (computed with esbuild `--metafile` over an entry
importing both; bundle 142.3 KB unminified). Layout is the upstream
`dist/` tree verbatim, so every file diffs clean against the npm package
except the patch below. Excluded: `dist/index.js` (re-exports
`generateDictionary`, unused here), `dictionary/generateDictionary.js`,
all `.d.ts` and `.map` files, and the `//# sourceMappingURL=` lines
(maps not vendored).

## Patch (3 sites, marked `z6-patch`)

Upstream zstdify 1.4.0's decoder caps every match offset at the frame's
window size:

    maxReachBack = min(produced + historyLength, windowSize)

That rejects VALID dictionary frames: a real zstd encoder emits matches
reaching into the dictionary with offsets larger than the frame window
(proven: native Node's dict-compressed frame for the
test-zlib-zstd-dictionary vectors carries offset 407 with windowSize 362,
and native decodes it fine). The dictionary is part of the window — the
cap must include its length. Patched sites:

- `dist/decode/fusedSequences.js` (~line 260)
- `dist/decode/reconstruct.js` (~lines 231, 398)

to:

    maxReachBack = min(produced + historyLength, windowSize + historyLength)

Non-dictionary behavior is unchanged (`historyLength === 0` reduces to
the old formula). The `reconstruct.js` no-history path (history hard-coded
0) is untouched. Verified: dictionary round-trips pass in all four dict
forms (Buffer / Uint8Array / ArrayBuffer / DataView) and against native
frames; all non-dict probe results (truncated, garbage, empty, doubled,
person.jpg.zst, levels, checksum) unchanged.

## Regeneration

    npm pack zstdify@1.4.0 && tar xzf zstdify-1.4.0.tgz
    # copy package/dist/*.js (reachable set above) to src/vendor/zstdify/dist/
    # strip //# sourceMappingURL= lines, re-apply the 3-site patch above

Pristine reference copy: `~/workspace/worktrees/zlib-l0-codec-probe/node_modules/zstdify`
(L0 probe worktree). Verify with:
`diff -r <pristine>/dist src/vendor/zstdify/dist` — only the 3 `z6-patch`
sites should differ (plus the stripped sourceMappingURL lines).
