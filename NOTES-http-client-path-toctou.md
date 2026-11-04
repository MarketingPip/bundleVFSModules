# test-http-client-path-toctou — ERR_UNESCAPED_CHARACTERS is a TypeError

## Test shape

`new http.ClientRequest({ host, port, path: "/valid", method: "GET",
createConnection: () => {} })`, then:

- Setting `req.path` to `/evil\r\nX-Injected: true\r\n\r\n` must throw
  `{ code: "ERR_UNESCAPED_CHARACTERS", name: "TypeError",
  message: "Request path contains unescaped characters" }`, and the path must
  be unchanged after the failed mutation.
- Lone CR, lone LF, and NUL must each throw `ERR_UNESCAPED_CHARACTERS`.
- Valid mutations (`/also-valid`, `/path?query=1&other=2`) must succeed.
- Then `req.destroy()`.

## Diagnosis

The shim's `ClientRequest` path setter (`src/http.js`, path setter) already
validated BEFORE assigning (so the path stays unchanged), and the
`ERR_UNESCAPED_CHARACTERS` factory message already matched exactly. The
validation regex `INVALID_PATH_REGEX = /[^\u0021-\u00ff]/` already rejects
CR (0x0D), LF (0x0A), and NUL (0x00).

The sole mismatch: `makeError(code, message, Constructor = Error)` defaults
to `Error`, and the factory passed no constructor — so the thrown error's
`name` was `Error`, not `TypeError`. Real Node throws a `TypeError` here
(probed on v24.22.1 via the failing assertion's expected value, and
consistent with the neighbouring `ERR_INVALID_HTTP_TOKEN` factory, which
already passes `TypeError`).

## Fix

One line in `src/http.js`: the `ERR_UNESCAPED_CHARACTERS` factory now passes
`TypeError` as the constructor. Both call sites (construction-time
validation and the path setter) share the factory, so one change fixes both.

## Verification

- Target passes isolated 3/3 on the branch; fails on pristine main
  (`66085049`) with the name mismatch (`Error` vs expected `TypeError`).
- Full 397-file differential vs pristine main `66085049`: see the PR body
  (expected: exactly 1 line toward pass, zero pass-to-fail).
