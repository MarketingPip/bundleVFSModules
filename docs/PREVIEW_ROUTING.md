# Preview routing — real navigable URLs for guest servers

Guest `http.createServer().listen(port)` servers run inside the sandbox.
The host fetch patch (`_vfsServerRoutes` in `runtime.js`) already routes
*programmatic* `fetch("http://localhost:3000/")` calls to them — but a
patched `fetch` can never cover address-bar navigation, iframes, or
new-tab previews. Preview routing closes that gap with a Service Worker:

```
GET /__virtual__/3000/api/users      (address bar, iframe, fetch — anything)
        │  Service Worker (src/preview-sw.js), scope /__virtual__/
        ▼  postMessage { type: "bvm:preview-request", … } → host page
host page (src/plugins/preview-routing.js)
        │  port→handler registry ← trackSandbox(sandbox) wires
        │  CodeSandbox "execution:server" open/close events
        ▼  sandbox.invoke("__serverRequest__", port, path, method, body, headers)
sandbox iframe → __httpServerRunTime.handleRequest → guest handler
        │  { statusCode, statusMessage, headers, body }
        ▼  postMessage { type: "bvm:preview-response", … } → SW
SW builds the Response
```

## URL scheme

`/__virtual__/{port}{path}` — e.g. `/__virtual__/3000/api/users?page=2`
routes to the guest server on port 3000 with path `/api/users?page=2`.
Port must be 1–65535; anything else is a 400.

## Usage (explicit opt-in)

```js
import {
  registerPreviewSW,
  trackSandbox,
} from "./src/plugins/preview-routing.js";

const sandbox = new CodeSandbox({ fs: {} });

// 1. Register the Service Worker (page-wide side effect — never automatic).
await registerPreviewSW("/__virtual__/preview-sw.js");

// 2. Wire this sandbox's server lifecycle into the route registry.
const untrack = trackSandbox(sandbox);

await sandbox.execute(`
  const http = require("node:http");
  http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<h1>hello from the guest</h1>");
  }).listen(3000);
`);

// Now http://<host>/__virtual__/3000/ serves the guest page —
// navigable, iframable, openable in a new tab.
```

`registerPreviewSW(swUrl?, { scope?, timeoutMs? })` defaults to serving
`/__virtual__/preview-sw.js` with scope `/__virtual__/`. Serve the file
at or under the scope so no `Service-Worker-Allowed` header is needed.
It resolves once the worker is ACTIVE (it awaits activation itself —
do not use `navigator.serviceWorker.ready`, which only resolves for
scopes covering the current page and would hang forever for a host page
outside `/__virtual__/`).
`trackSandbox` returns an untrack function; call it when the sandbox is
torn down. First claim wins on port collisions (same rule as the host
fetch bridge).

## Error surfacing (the `forwardPreviewErrors` pattern)

Borrowed from WebContainers: a failed preview renders a readable HTML
error page, never a blank tab or a hang.

| Situation | Status | Body |
|---|---|---|
| No guest server on the port | 502 | "No guest server listening on port N" + `http.createServer(...).listen(N)` hint |
| Guest handler threw | 502 | the error message |
| Host page never answered | 504 | timeout page |
| Malformed preview URL | 400 | "Not a preview URL" |
| No client page (SW orphaned) | 502 | "no client page to answer" |

The SW never hangs: every request path ends in a `Response` (20s cap on
the host round-trip).

## Limitations (honest)

- **Secure context required.** Service Workers need HTTPS or localhost.
  `registerPreviewSW` throws a clear error otherwise.
- **First-load race.** A page that registers the SW is not itself
  controlled until reload (or `clients.claim()` — the SW does claim, but
  claim timing vs. first paint is racy). New clients — iframes, new tabs,
  navigations *after* registration — are controlled immediately. In
  practice: register early, open previews late.
- **One SW per scope.** If the host app already has a SW on `/`, ours
  must be registered with the narrower `/__virtual__/` scope (supported:
  scopes nest, the most specific wins).
- **Scope is a hard boundary.** The SW only sees clients under
  `/__virtual__/`. `fetch()` issued from the host page itself (outside the
  scope) is NOT intercepted — that is correct Service Worker behavior, not
  a bug. In-scope clients (preview iframes, navigations, new tabs) are
  covered. If the host app needs its own JS to call guest servers, keep
  using the host fetch patch (`localhost:{port}` URLs).
- **No streaming (yet).** The full body is buffered host-side before the
  `Response` is built. SSE/chunked guest responses work but arrive
  buffered. True streaming would need a ReadableStream bridge over
  postMessage — future work.
- **No WebSocket upgrade.** `ws://` upgrades can't traverse this path;
  use the runtime's WebSocket handling instead.
- **Cross-tab fan-out.** The SW broadcasts to all window clients and takes
  the first reply. Two tabs with bridges on the same port: first reply
  wins (documented, matches first-claim-wins).

## What the SW does NOT do

`src/preview-sw.js` is a thin transport: match URL → read body →
postMessage → build Response. It owns no routing state, validates nothing
beyond a coarse regex, and knows nothing about sandboxes. All policy —
URL parsing (`parsePreviewUrl`), the route registry, body normalization,
error mapping — lives in `src/plugins/preview-routing.js` and is unit
tested (`tests/preview-routing.test.js`). The browser proof is
`tests/preview-routing-e2e.py` + `.html` (headed Firefox): iframe
navigation to `/__virtual__/{port}/` serves the guest response, and an
unclaimed port renders the 502 page.
