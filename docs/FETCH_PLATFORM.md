# Fetch Platform Audit — iframe realm vs Node 20 undici

**Date:** 2026-10-04 (initial) · 2026-10-11 (deep audit, roadmap §5 checkoff)
**Method (2026-10-04):** Differential testing via `parity/real-runtime.mjs` (genuine CodeSandbox iframe) + headed Firefox e2e drivers
**Method (2026-10-11):** 46-observation differential across **three lanes** — Node 24 undici (reference), native browser fetch (page lane, headed Firefox 156.0.1 under Xvfb), and the genuine CodeSandbox lane (our `patchedFetch` wrapper + parent `_fetch_` interop). The wrapper lane is what actually ships to user code.
**Reference:** Node v24.20.0 undici
**Browser:** Firefox 156.0.1 (headed, Xvfb)

## Summary (2026-10-11)

**Layer 1 — native browser fetch/Headers/Response/Request vs undici: 39/46 parity.** All constructor, body-streaming, cloning, redirect, abort, and content-type behaviors match. The 7 divergences are browser security boundaries or spec-level differences — none patchable, all documented below.

**Layer 2 — our wrapper (`src/sandbox/70-fetch.js` + parent `_fetch_` interop) vs undici: 4 real gaps found, all patched and verified.** The native layer needed no patching (the existing `getSetCookie` polyfill stands); our own wrapper was the thing diverging from undici:

| # | Gap (wrapper pre-patch) | Fix | Verified |
|---|---|---|---|
| W1/W2 | Caller's `AbortSignal` silently replaced — `abort()` had no effect; already-aborted signals ignored | Compose user signal into the internal controller; race the parent-interop wait against abort so user aborts **and** the 30s timeout actually terminate the wait | `AbortError` at ~204ms (was: resolved after 5s) |
| W4 | `redirected` always `false`, `type` always `"default"`, `url` = pre-redirect input URL | Parent reports post-redirect `url` + `redirected` + `type`; sandbox applies them via `defineProperty` | `redirected:true`, `url` ends `/done`, `type:"basic"` |
| W8 | `fetch(requestObject)` → unhandled non-Error rejection (`{}`), killing `execute()` | Normalize `Request` → serializable `(url, init)` for the parent path (Request isn't structured-cloneable); buffer body via `clone().arrayBuffer()`; native fallback keeps the original | `method:POST, body:"rb"` round-trips |
| — | `.finally()` tracking branch could surface unhandled rejections | No-op `.catch()` on the tracking branch (the `await` still reports errors) | No unhandled rejections in lane |

**Accepted limitations** (documented with reasons, not patched): `set-cookie` invisibility, `redirect:'manual'` → `opaqueredirect`, forbidden request headers, 30s fetch timeout (sandbox DoS guard), buffered-not-streaming bodies through the parent interop, CORS, Firefox streaming-upload quirk. Details in the gap tables below.

---

## Deep audit 2026-10-11 — method

Three lanes, same 46 observations (`tests/fetch-audit-deep.js` = Node reference;
`tests/fetch-audit-deep-e2e.html` + `.py` = browser-native page lane;
`tests/fetch-wrapper-e2e.html` + `.py` = genuine CodeSandbox wrapper lane):

- **H1–H8** — Headers: has/delete, iteration order, empty/trimmed/`undefined` values, manual set-cookie, forbidden-header guard on `Request`, immutable guard on `Response.error()`
- **R1–R14** — Response: text/arrayBuffer, json charset, bodyUsed, clone, tee, 204-with-body, bad redirect status, redirect default, statusText default, URLSearchParams/FormData/Blob/stream bodies, clone-after-used
- **Q1–Q10** — Request: method normalization, forbidden methods, streaming body ± `duplex:'half'`, clone, construct-from-Request, `only-if-cached`, `mode:'navigate'`, defaults
- **F1–F14** — real `fetch()`: data: URL, redirect follow/manual/error, on-the-wire headers, POST JSON, multipart round-trip, gzip, set-cookie, abort (mid-flight + already-aborted), 404, HEAD, Request-object input

The local HTTP server (same endpoints in the Node script and the Python drivers)
serves: `/echo` (method/url/headers/body JSON), `/redirect` (302 → `/done`),
`/done`, `/cookies` (two `Set-Cookie`), `/slow` (5s delay), `/gzip`,
`/form` (raw multipart echo), 404s.

## Layer 1 gap table — native browser vs undici

39/46 observations identical. Divergences:

| Check | Node 24 undici | Firefox 156 native | Verdict |
|---|---|---|---|
| H7 forbidden headers on `Request` | `cookie`/`host`/`connection`/`referer`/`origin` kept on the object | filtered to `null` (forbidden request-header guard) | **Accepted** — browser security boundary; undici is the lax one here |
| Q3 streaming body without `duplex` | `TypeError` (duplex required) | no throw | **Accepted** — Firefox lacks streaming-upload support entirely (see Q4); Chrome 105+ matches undici |
| Q4 streaming body + `duplex:'half'` | streams chunks, `body` is a `ReadableStream` | body becomes the string `"[object ReadableStream]"`, `body` is null | **Accepted** — Firefox quirk (no streaming request bodies); Chrome 105+ matches undici |
| F3 `redirect:'manual'` | 302 response with `location` (type `basic`) | `opaqueredirect`, status 0, empty headers | **Accepted** — fetch-spec difference, not patchable (browser hides redirect responses) |
| F5 on-the-wire request headers | user `cookie`/`referer`/`origin`/`connection` sent as given | `cookie`/`origin` dropped; `referer` overridden with the document URL; `connection` → `keep-alive` | **Accepted** — forbidden-header filtering + browser-managed headers; cannot be patched |
| F9 `set-cookie` on real responses | `getSetCookie()` → 2 entries | `get()` → null, `getSetCookie()` → `[]` | **Accepted** — forbidden *response* header; filtered before JS (see 2026-10-04 §1) |
| F12 404 body | `"nope"` | `"not found"` | N/A — harness artifact (different stub servers), not a platform difference |

**Conclusion for Layer 1:** no patchable gaps. The `src/fetch-patch.js` defensive
`getSetCookie` polyfill (for browsers lacking it natively) remains the only
platform patch needed.

## Layer 2 gap table — our wrapper vs undici (all patched 2026-10-11)

Pre-patch observations from the genuine CodeSandbox lane; every row now verified fixed:

| Check | Pre-patch (wrapper) | Post-patch (wrapper) | Fix location |
|---|---|---|---|
| W1 abort mid-flight (`/slow`, abort at 200ms) | resolved `"slow-done"` at ~5s — abort **ignored** | `AbortError` (`DOMException`) at ~204ms | `src/sandbox/70-fetch.js`: compose user signal into the internal controller; `Promise.race` the interop wait against abort |
| W2 already-aborted signal | fetch proceeded (signal discarded) | immediate `AbortError` | same |
| W4 redirect follow | `redirected:false`, `url:"…/redirect"`, `type:"default"` | `redirected:true`, `url:"…/done"`, `type:"basic"` | `src/runtime/code-sandbox.js`: parent returns `response.url` (was: the input), `redirected`, `type`; `70-fetch.js` applies them |
| W8 `fetch(requestObject)` | **unhandled rejection `{}`** — `execute()` died | works: `method:POST, body:"rb", x-via` preserved | `70-fetch.js`: serialize `Request` → `(url, init)` for the parent path; buffer body via `clone().arrayBuffer()`; fallback keeps the original `Request` |
| (incidental) | `.finally()` tracking branch could reject unhandled | silenced with no-op `.catch()`; the `await` still surfaces errors | `70-fetch.js` (both paths) |

Also fixed along the way: the reconstruction passed a bogus `url: "test"` member
in the `Response` init dict (ignored by the constructor — removed).

**Behavioral note:** the 30s timeout previously did nothing on the parent path
(the interop promise isn't tied to the controller). The abort race makes it
real: parent-path fetches exceeding 30s now abort. This matches the documented
intent ("timeout and abort support") and is kept as a sandbox DoS guard (see
accepted limitations).

### Firefox `Request.prototype.body` quirk (found while patching W8)

Firefox 156 does **not** implement `Request.prototype.body` — it is `undefined`
(`"body" in Request.prototype === false`), even though `clone().arrayBuffer()`
/ `.text()` work fine. The W8 body buffering therefore keys off the HTTP method
(GET/HEAD skip) and reads `clone().arrayBuffer()`, treating an empty buffer as
no body — instead of testing `.body` for null. Portable across Firefox/Chrome.

## Accepted limitations (not patched, with reasons)

| Limitation | Reason |
|---|---|
| `set-cookie` invisible on real responses (W3/F9) | Browser forbidden-response-header filtering; values never reach JS in any realm — unpatchable. Workarounds in 2026-10-04 §1 (`document.cookie`, `__cookieJarLib`, JSON/session endpoint) still apply. |
| `redirect:'manual'` → `opaqueredirect` (F3/W5) | Fetch-spec browser behavior; redirect responses are hidden from JS. The wrapper falls back to native fetch here, which is correct. |
| Forbidden request headers dropped (H7/F5) | Browser security boundary (`cookie`, `host`, `connection`, `referer`, `origin` managed by the browser). |
| 30s default fetch timeout | Deliberate sandbox DoS guard (runaway fetches would hang `waitForAllFetches`/the task tracker). Now actually enforced on both paths via the abort race. |
| Response bodies are buffered, not streamed, through the parent path | The parent interop crosses `postMessage` — bodies must be serialized (`text()`/`arrayBuffer()`). Progressive streaming (SSE-style) over the parent path is not possible; the reconstructed `Response` still exposes a (buffered) `ReadableStream` via `.body`. |
| CORS failures | Browser security model; undici has no CORS. Same as any browser `fetch`. |
| Firefox streaming uploads (Q3/Q4) | Firefox lacks `duplex:'half'` upload streaming (stringifies the stream); Chrome 105+ matches undici. Platform version quirk, not patchable from our layer. |

## 2026-10-04 findings (kept)

The original 18-check audit and its conclusions stand: full parity for
`Headers`/`Response`/`Request` constructors and local behaviors, with the
`set-cookie` platform limit documented in §1 below. The deep audit above
supersedes the "What was NOT tested" list — streaming bodies, cloning,
`duplex`, redirect handling, and real-network `fetch()` are now covered.

---

## Summary

The iframe realm has **full parity** with Node 20 undici for `Headers`, `Response`, and `Request` constructors and local behaviors (18/18 checks green in both lanes). 

**One platform limit** breaks real code: browsers filter the `set-cookie` response header before JavaScript ever sees it. This is a browser security boundary, not a shim bug — it cannot be patched.

## Divergences

### 1. `set-cookie` response headers are invisible to JavaScript [PLATFORM LIMIT]

**Severity:** HIGH — breaks real code (session handling, auth flows that read cookies from fetch responses).

**Node behavior:**
```js
const r = await fetch('https://example.com'); // server sends 2 Set-Cookie headers
r.headers.get('set-cookie');      // "a=1; Path=/, b=2; Path=/"
r.headers.getSetCookie();         // ["a=1; Path=/", "b=2; Path=/"]
```

**Browser behavior:**
```js
const r = await fetch('https://example.com');
r.headers.get('set-cookie');      // null
r.headers.getSetCookie();         // []
```

**Why:** `set-cookie` is a [forbidden response header name](https://fetch.spec.whatwg.org/#forbidden-response-header-name). Browsers filter it before constructing the Headers object. This is a spec-level security boundary — JavaScript cannot opt out.

**Can it be patched?** No. The browser never exposes the values to JS. A polyfill of `getSetCookie()` would return `[]` — honest, but useless. The values are simply unavailable.

**Workaround for developers:** 
- Read cookies from `document.cookie` (for same-origin requests)
- Have the server expose session state via a JSON endpoint or custom header (not `set-cookie`)
- Use the `__cookieJarLib` in the sandbox (the runtime already merges cookies for outgoing requests)

**Verified:** `tests/fetch-setcookie-e2e.py` + `.html` — 2/4 checks fail in Firefox (the set-cookie ones), 2/4 pass (custom headers, redirect).

---

### 2. `Headers.prototype.getSetCookie` availability [NO DIVERGENCE in modern browsers]

**Status:** PARITY in Firefox 156 (both page and sandbox iframe contexts).

`getSetCookie()` exists natively. For older browsers that lack it, `src/fetch-patch.js` provides a defensive polyfill that returns `[]` (honest — matches the filtered behavior).

---

## Parity checklist (all green)

These were differentially tested via `parity/real-runtime.mjs` (Node vs genuine sandbox iframe):

| Check | Node | Browser | Status |
|---|---|---|---|
| Headers: case-insensitive get | ✅ | ✅ | PARITY |
| Headers: getSetCookie exists | ✅ | ✅ | PARITY |
| Headers: getSetCookie returns array | ✅ | ✅ | PARITY |
| Headers: multi-value append joins with ', ' | ✅ | ✅ | PARITY |
| Headers: set() replaces | ✅ | ✅ | PARITY |
| Headers: invalid name throws TypeError | ✅ | ✅ | PARITY |
| Headers: invalid value throws TypeError | ✅ | ✅ | PARITY |
| Headers: iteration sorted by name | ✅ | ✅ | PARITY |
| Response: json() content-type | ✅ | ✅ | PARITY |
| Response: json() body parses | ✅ | ✅ | PARITY |
| Response: invalid status throws RangeError | ✅ | ✅ | PARITY |
| Response: invalid statusText throws TypeError | ✅ | ✅ | PARITY |
| Response: redirect() status/location | ✅ | ✅ | PARITY |
| Response: error() type/status | ✅ | ✅ | PARITY |
| Request: GET with body throws TypeError | ✅ | ✅ | PARITY |
| Request: POST with string body works | ✅ | ✅ | PARITY |
| Request: headers accessible | ✅ | ✅ | PARITY |
| Request: url normalized | ✅ | ✅ | PARITY |

**Test command:**
```bash
node parity/real-runtime.mjs fetch tests/fetch-audit.test.js
# verdict: PARITY
```

## What was NOT tested (out of scope)

- **Actual network fetch()** with real servers (beyond the set-cookie probe): the sandbox's `connect-src *` CSP allows it, and the http.js client is fetch-backed. Network behavior is browser-native.
- **`Request` with streaming bodies** (`duplex: 'half'`): both Node and browsers require it; not differentially tested.
- **WebSocket**: not part of fetch API.

## Related issues found (out of scope)

- **`node:assert` shim broken in sandbox**: `import assert from "node:assert"` fails in the CodeSandbox iframe (DIVERGENCE via harness), though it works in Node. This is a separate bug in the assert shim or module resolution — not a fetch issue. Reported for follow-up.

## Files

- Audit: `tests/fetch-audit.test.js` (18 checks, runnable via Node or harness)
- Browser audit: `tests/fetch-audit-e2e.html` + `tests/fetch-audit-e2e.py` (18/18 PASS in Firefox)
- Set-cookie probe: `tests/fetch-setcookie-e2e.html` + `tests/fetch-setcookie-e2e.py` (documents the platform limit)
- Patch: `src/fetch-patch.js` (defensive `getSetCookie` polyfill)
- Patch tests: `tests/fetch-platform.test.js`
