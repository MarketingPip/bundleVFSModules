# NOTES — inspector validation lane I-V1

Ship: `fix/inspector-validation-v1` → PR #___ (merge SHA ___; filled by docs sync).
Base: main `327b0226`. Scope: `src/inspector.js` + `tests/inspector.test.js`
(oracle-cited jest updates — see §5) + this file.

## Result

**35/75** (banked 30/75 + 5 flips, 0 regressions). All 5 flips verified
2× isolated on the branch (exit 0) and 2× on pristine main (exit 1):

| Test | Flip | Oracle |
|---|---|---|
| `test-inspector-module.js` | ✓ | `lib/inspector.js:118-133` — post validates method/params/callback, throws `ERR_INSPECTOR_NOT_CONNECTED` when not connected |
| `test-inspector-open-port-integer-overflow.js` | ✓ | `lib/inspector.js:175-178` — `isUint32(port)` → `validateInt32(port, 'port', 0, 65535)`; `open(99999)` → `ERR_OUT_OF_RANGE` |
| `test-inspector-host-warning.js` | ✓ | `lib/inspector.js:179-188` — non-loopback host → `process.emitWarning(<exact message>, 'SecurityWarning')`; `isLoopback` per `lib/internal/net.js:90-99` |
| `test-inspector-wait-for-connection.js` | ✓ | `lib/inspector.js:200-207` — `waitForDebugger()` throws `ERR_INSPECTOR_NOT_ACTIVE` ("Inspector is not active") when not active |
| `test-inspector-emit-protocol-event-errors.js` | ✓ (probable, landed) | `src/inspector/network_agent.cc` + `dom_storage_agent.cc` (ThrowEventError) — ~60 field validators, exact `"Missing X in event"` / `"Invalid header … in event"` / `"Failed to … storageMap"` messages, `Uint8Array` checks |

Differential (full 73-file inspector glob, fast-sweep, branch vs fresh base
at the same main tip): branch 34 pass / base 29 pass; the CSV diff is
exactly the 5 flips, 0 regressions, 0 mode changes.
CSVs: `hidden_files/fast-sweep/inspector-sweep-i-v1-branch.csv`,
`inspector-sweep-i-v1-base.csv` (vs triage base
`inspector-sweep-2026-11-18.csv`: toward-pass=5, regressions=0).
Plus `test-inspector-wait.mjs` exit 0 on both sides → **35/75 total**.

## Throws implemented (each probe-proven natively first)

Error factory: plain `Error`/`TypeError`/`RangeError` + `.code`, with
`toString()` overridden to `` `${name} [${code}]: ${message}` `` — the
native format (`name` stays the plain class name; `src/internals/errors.js`
was NOT used — its `name` getter returns `TypeError [CODE]`, which fails
`assert.throws` name checks). `invalidArgTypeHelper` copied from
`src/http2.js:73-90`.

- `Session.post()` — validateString(method) → params-shift
  (`!callback && typeof params === 'function'`) → validateObject(params)
  if truthy → validateFunction(callback) → `ERR_INSPECTOR_NOT_CONNECTED`
  ("Session is not connected") if not connected. Domain enable/disable
  (`Network.enable/disable`, `DOMStorage.enable/disable`) flips the
  module-level flags the broadcasters gate on.
- `Session.connect()` — `ERR_INSPECTOR_ALREADY_CONNECTED` ("The inspector
  session is already connected") when connected.
- `Session.connectToMainThread()` — `ERR_INSPECTOR_NOT_WORKER` ("Current
  thread is not a worker") on the main thread (via lazy
  `process.getBuiltinModule('worker_threads')?.isMainThread`, util.js
  precedent, guarded fallback true); else ALREADY_CONNECTED.
- `Session.disconnect()` — safe when not connected. Pending callbacks are
  NOT failed with `ERR_INSPECTOR_CLOSED`: no vendored test covers it;
  recorded divergence.
- `open(port, host, wait)` — `isUint32(port)` → `validateInt32(port,
  'port', 0, 65535)`; non-loopback host → `process.emitWarning(<exact
  oracle message>, 'SecurityWarning')` (guarded
  `typeof process.emitWarning === 'function'`); sets active. `close()`
  clears it. `waitForDebugger()` throws `ERR_INSPECTOR_NOT_ACTIVE` when
  not active.
- Broadcasters — `broadcastToFrontend` validates eventName (string) +
  params (object) FIRST (throws even when disabled), then silent return
  if the domain is disabled (C++ `emitNotification` IsEnabled gate — this
  is why `requestWillBeSent({})` after `Network.disable` in
  `emit-protocol-event` must NOT throw), then the C++ field validators,
  then params are dropped (no delivery exists). `NetworkResources.put`
  stays a noop. `dataSent` order: requestId → registry lookup (silent
  return if unregistered — the test registers its id with `startRequest`
  first) → `finished` bool short-circuit → timestamp → dataLength → data
  → Uint8Array (toString-tag check, cross-realm). `registerStorage`:
  bool isLocalStorage → object storageMap → `Object.keys` in try/catch
  ("Failed to get property names from storageMap") → per-key read in
  try/catch ("Failed to get value from storageMap"). StorageId:
  securityOrigin string → isLocalStorage bool no-throw → storageKey
  string.

Native probes (host Node v24.22.1, 2026-11-18, before implementation):
`open(99999)` → `ERR_OUT_OF_RANGE` with the exact message;
`post()` without connect → `ERR_INSPECTOR_NOT_CONNECTED`;
`connectToMainThread()` on main → `ERR_INSPECTOR_NOT_WORKER`;
`waitForDebugger()` inactive → `ERR_INSPECTOR_NOT_ACTIVE`;
`session.connect()` twice → `ERR_INSPECTOR_ALREADY_CONNECTED`;
anonymous-function helper suffix is `Received function ` (empty name).

## Deliberately NOT implemented

- `url()` still returns `undefined` — a fabricated `ws://` URL for an
  inspector that isn't listening would be a fake success (rule 7).
  `already-activated-cli` / `close-worker` / `open` stay NO-FIX.
- `open()` does NOT throw `ERR_INSPECTOR_ALREADY_ACTIVATED` on a second
  call: no vendored test asserts it, and the repo jest `open()` tests call
  `open()` twice in one process without `close()` in between.
- `emit-protocol-event` + `connect-main-thread` beyond their first
  assertion: their rests need live protocol delivery. Both still fail
  (exit 1) on branch and base — but the failure point MOVED, which is
  progress, not a regression (see §4).

## No-flip guards — failure point moved, outcome unchanged

Both tests exit 1 on branch and base; neither newly passes nor newly
crashes. What changed is WHERE they fail:

- `test-inspector-emit-protocol-event.js` — base fails at assertion 1
  (`Missing expected exception (TypeError)` — the stub never threw).
  Branch passes all validation assertions and fails at line 190:
  `Mismatched <anonymous> function calls. Expected exactly 1, actual 0`
  — the `inspectorNotification` mustCall callback never fires, because no
  live protocol delivers the event.
- `test-inspector-connect-main-thread.js` — base fails at assertion 1
  (`Missing expected exception (Error)`). Branch passes the
  `ERR_INSPECTOR_NOT_WORKER` assertion and fails at line 196
  (`skipChildMain`: `0 !== 2` — received-notification counter is 0,
  expected 2; no live delivery).

## Jest-test conflict found in-lane (resolved, parent to verify hunks)

The repo's own `tests/inspector.test.js` pinned the OPPOSITE of the
vendored tests for 10 assertions — and a native probe proved every pin
wrong about real Node (see §2 probes): `post()` without connect resolving
`{}` (5 tests), `connectToMainThread()` not throwing on the main thread,
`waitForDebugger()` not throwing when inactive, and the two promises
`post()` tests without connect. This is the Z5 / H2-V6 / H2-V4 shape
(repo test provably wrong about real Node → update it with oracle-cited
hunns), NOT the module `create-require` shape (there the repo pin serves
a real product need — vite chunk loading — and no signal distinguishes
the two consumers; here the pin serves nothing, it's a stale stub-era
expectation, and nothing in the product needs post-before-connect to
resolve `{}`).

Changes to `tests/inspector.test.js` (minimal, each hunk oracle-cited):
the 3 "does not throw" tests became throw assertions (`ERR_INSPECTOR_
NOT_WORKER`, `ERR_INSPECTOR_NOT_ACTIVE`); the 5 callback-mechanics post
tests + 2 promises post tests + 1 fallback promises test now call
`connect()` first (their intent is callback mechanics, not connection
state); 4 new tests pin the oracle behavior (`post()` throws
`ERR_INSPECTOR_NOT_CONNECTED` when not connected, double `connect()`
throws `ERR_INSPECTOR_ALREADY_CONNECTED`, `post()` arg validation,
`open(99999)` throws `ERR_OUT_OF_RANGE`).

Verification: branch jest `tests/inspector.test.js` **40/40** (was 36);
base jest `tests/inspector.test.js` **36/36** on pristine main;
branch footprint + export-surface suites
(`tests/ondemand-require.test.js`, `tests/export_surface_inspector*.test.js`)
**31/31** (footprint 29/29 as expected).

## Header-convention reconciliation

The stub's old header line ("per project convention noop stubs never
throw") covered APIs that cannot exist in a browser (UDP sockets, raw
TLS, … — repo AGENTS.md rule 2, "Noop over throw"). It never covered
Node's own argument/state checks on an API that exists as a facade:
where Node's API throws in exactly the states the official tests assert,
implementing the throw is faithful porting — the http2 V4 precedent
(`respond()` throwing `ERR_HTTP2_INVALID_STREAM`, etc.). The header now
says this explicitly. What stays a noop: everything with no backend
(post results `{}`, broadcasters dropping params, `url()` undefined).

## Approval-timeout flag (for the parent)

The two fast-sweep execs (branch sweep, base sweep) each returned
complete output AND wrote their CSVs (verified by direct file read:
branch 00:18, base 00:30, 34 vs 29 `,0` rows, diff exactly the 5 flips),
but the runtime reported `userConfirmationStatus: timed_out` for both
approvals. I did not retry either sweep. The CSV evidence stands on its
own; the parent may want to note the approval-correlation hiccup (the
first attempt also failed with "2 conflicting pending approval
identities").
