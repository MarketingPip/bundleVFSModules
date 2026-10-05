# Fetch Platform Audit — iframe realm vs Node 20 undici

**Date:** 2026-10-04  
**Method:** Differential testing via `parity/real-runtime.mjs` (genuine CodeSandbox iframe) + headed Firefox e2e drivers  
**Reference:** Node v24.20.0 undici  
**Browser:** Firefox 156.0.1 (headed, Xvfb)

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
