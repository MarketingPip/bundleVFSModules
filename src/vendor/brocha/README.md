# brocha 0.1.1 — vendored (zlib Z5)

Vendored 2026-11-18 for the Brotli decoder in `src/zlib.js`. Pure-JS Brotli
decompression (MIT, upstream: https://www.npmjs.com/package/brocha).
Vendored instead of a package.json dependency: the repo's footprint test
(`tests/ondemand-require.test.js`) allows only `^src/`, `^parity/`,
`^NOTES-[^/]+\.md$`, `^docs/capability-matrix.json$` — `package.json` is NOT
allowed, so a dep line there fails CI (that is exactly what failed PR #466's
first CI run).

## Contents

1 file: upstream `dist/index.js` verbatim (the non-minified ESM build; the
package's `module` entry is the minified `dist/index.min.js`, which exports
the same names with renamed internals — the readable build is vendored so
the diff stays reviewable). Only `decompress` is imported by `src/zlib.js`;
the file also exports the `BrotliDecoder*Error` classes and `State`, which
the error mapping reads via `err.code` / `err.name` on thrown instances.
Excluded: `.d.ts` and `.map` files, the `//# sourceMappingURL=` line (maps
not vendored), and the CJS/UMD builds (unused under ESM).

## Patch

None. Upstream file used unmodified.

## Regeneration

    npm pack brocha@0.1.1 && tar xzf brocha-0.1.1.tgz
    # copy package/dist/index.js to src/vendor/brocha/dist/index.js
    # strip the //# sourceMappingURL= line

Pristine reference copy: `~/workspace/worktrees/zlib-l0-codec-probe/node_modules/brocha`
(L0 probe worktree). Verify with:
`diff <pristine>/dist/index.js src/vendor/brocha/dist/index.js` — only the
stripped sourceMappingURL line should differ.
