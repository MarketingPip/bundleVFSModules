# Interop — every function the sandbox boundary exposes

`runtime.js` runs user code in a sandboxed iframe. The sandbox and the host
page talk over `window.postMessage` through a small RPC layer: the **interop
channel**. This document lists every function exposed on that channel in each
direction, and walks through exactly how a server request is made and how its
response gets back.

Related docs: `docs/RUNTIME.md` (how the host loads shims), `docs/EVENTS.md`
(the `CodeSandbox` events this channel feeds).

## How the channel works

Both directions follow the same shape:

1. Caller generates a random `callId` and posts a message with it.
2. Callee runs the function (sync or async) and posts the result back with
   the same `callId`.
3. The caller resolves or rejects a promise. **Both directions time out after
   10 seconds** (`Interop call timeout` / `Interop invoke timeout`).

Message types on the wire:

| Type | Direction | Meaning |
| ---- | --------- | ------- |
| `interop_call` | sandbox → parent | "run this parent-registered method" |
| `interop_response` | parent → sandbox | result of an `interop_call` |
| `interop_invoke` | parent → sandbox | "run this sandbox-exposed method" |
| `interop_result` | sandbox → parent | result of an `interop_invoke` |
| `interop_registered` | sandbox → parent | announces a newly exposed sandbox method (fires `execution:interop_registered`) |

Errors cross the boundary as structured `{ message, code, name }` so
`err.code` (e.g. `ERR_MODULE_NOT_FOUND`) survives the trip; legacy string
errors are still accepted.

The sandbox side lives in `src/sandbox/30-interop.js` (`interopChannel`):
`callParent(method, ...args)` calls the parent, `expose(name, fn)` makes a
sandbox function callable by the parent. Three methods are treated as
runtime-internal and are **not** announced via `interop_registered`:
`__check_exists__`, `__stdin__`, `__serverRequest__`.

The parent side lives in `runtime.js`: `registerInterop(name, handler)` /
`unregisterInterop(name)` manage the methods the sandbox may call, and
`sandbox.invoke(method, ...args)` calls into the sandbox.

---

## Parent → sandbox: methods the sandbox calls

The sandbox calls these with `interopChannel.callParent(name, ...args)`.

### `_getState`

Returns the sandbox bootstrap template (a string of JS) that the sandbox
`import()`s from a `data:` URL at startup (`src/sandbox/80-errors.js`). This
is how the iframe gets its runtime object, module loader, console shims,
process shim, timers, fetch/XHR wrappers, and error handling.

### `_dynamic_import(path, type, entryPoint, parentEntryPoint, isNodeBuiltIn, cwd, vfs)`

Resolves a module specifier to **source text**. Called by the sandbox module
loader (`src/sandbox/20-module-loader.js`).

- Node builtins (`isNodeBuiltIn`) are served from our `dist/` shim bundles
  via `fetchBuiltinSource(path)`.
- Relative paths resolve against the virtual FS built from the host's `fs`
  config (flat `{ path: contents }` is unflattened first; leading slashes are
  normalized).
- Bare specifiers walk up `node_modules` directories, honoring `package.json`
  `main` and `index.js` fallbacks.
- Misses throw `ERR_MODULE_NOT_FOUND`.

### `_build_file(source, fileName, moduleType, entryPoint, parentEntryPoint, isNodeBuiltIn)`

Transforms module source before the sandbox evaluates it:

1. CJS → ESM conversion (for `import` of CJS) or ESM → CJS (for `require()`
   of an ESM builtin).
2. `globalThis._RUNTIME_` → `globalThis._RUNTIME<uuid>_` rewrite for builtins
   (see `docs/RUNTIME.md`).
3. `import … from "…"` → `loadModule("…")` rewriting; for CJS loaded via
   `require()`, nested `require()` calls are preserved so the synchronous
   `__syncRequire__` can handle them (rewriting them to `await loadModule`
   would break the sync wrapper).
4. Per-pass source maps are composed into one final → original map and stored
   in `_sourceMapRegistry` for parent-side stack mapping.

### `_fetch_(url, options)`

Runs `fetch` in the host page (with an adapter) and returns a
postMessage-serializable response. Used by the sandbox fetch/XHR shims
(`src/sandbox/70-fetch.js`, `71-xhr.js`) when the request must go through the
parent.

### `_bundler_(url)`

Rewrites an `esm.sh` URL to its `?bundle` form and returns the bundled URL.
Used by the module loader's CDN fallback.

### `_dynamic_import2` — legacy test fixture

Registered but serves hardcoded fixtures (`./serialize`, `./test`). Not part
of the real module pipeline; do not build on it.

---

## Sandbox → parent: methods the host calls

The host calls these with `sandbox.invoke(name, ...args)`.

### `__check_exists__(methodName)`

Returns whether a sandbox-exposed method exists. Capability probe; the parent
can check before invoking.

### `__stdin__(data)`

Pushes data into the sandbox's `process.stdin` (only when stdin has `data` /
`keypress` listeners and isn't paused). This is how the host feeds keystrokes
to a REPL running in the sandbox. If the push throws, the error is re-thrown
into the runtime instead of being posted back (see `src/sandbox/30-interop.js`).

### `__terminal_resize__({ cols, rows })`

Sets `process.stdout` / `process.stderr` columns and rows and emits Node's
`resize` event on both, so readline and guest `resize` listeners react.
Exposed for `sandbox.setTerminalSize(cols, rows)`, which validates the args,
invokes this, and emits `terminal:resize` on the host (see `docs/EVENTS.md`).

### `__serverRequest__(port, url, method, body, headers)`

The entry point for emulated inbound HTTP requests — the full flow is
documented in the next section.

### Demo-only registrations

`alert` and `readFile` are registered at the bottom of `runtime.js` as
examples for embedders. They are not part of the runtime contract.

---

## How a server request is made (and actually returned)

There is no TCP in the browser. `http.createServer()` in the sandbox creates
a **virtual** server registered in an in-process map keyed by port
(`src/http.js`, `serverRegistry`). A request is an ordinary function call
across the interop boundary, and the response is its return value.

### 1. The server starts listening

```js
// inside the sandbox
import http from 'node:http';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ hello: 'world' }));
});
server.listen(3000);
```

`listen()` registers the server in `serverRegistry` and forwards a lifecycle
event to the host via `RT.emit('serverListening', null, { port })`. The host
re-emits it as `execution:server`:

```js
// host page
sandbox.on('execution:server', async ({ type, port }) => {
  if (type === 'open') {
    console.log('server up on', port);
    const res = await sandbox.invoke('__serverRequest__', 3000, 'GET', '/api/users/1', {});
    console.log(res.statusCode, res.body.toString());
  }
  if (type === 'closed') {
    console.log('server down');
  }
});
```

(`server.close()` similarly produces `{ type: 'closed' }`.)

### 2. The host invokes `__serverRequest__`

Signature: `__serverRequest__(port = 8080, url = "/", method = "GET",
body = {}, headers = {})`. A legacy arg order `(port, method, url, headers,
body)` is also accepted and normalized by shape (methods are uppercase
tokens, URLs start with `/`).

Before dispatching, the sandbox wrapper (`src/sandbox/85-keydecoder.js`):

1. Injects cookies from the virtual RFC 6265 cookie jar for this
   sandbox + port into the request headers.
2. Calls `globalThis._RUNTIME_.__httpServerRunTime.handleRequest(port, url,
   method, body, headers)`.
3. Stores any `Set-Cookie` response headers back into the jar.

### 3. The bridge builds a real request/response pair

`handleRequest` in `src/http.js` (the documented signature is
`handleRequest(port, url, method, body, headers)`):

1. Looks up the server in `serverRegistry` by port. If the port misses but
   any server is listening, it falls back to the first one. With no servers
   at all it throws `ERR_NO_SERVER`.
2. Lowercases header names (Node lowercases incoming headers; Express
   relies on it) and preserves originals in `req.rawHeaders`.
3. Converts a plain-object body to JSON (`content-type: application/json`);
   an empty object becomes no body. Sets `content-length` when the caller
   didn't (so `express.json()` actually parses the body).
4. Calls `server.handleRequest(method, url, headers, payload)`, which
   constructs a real `IncomingMessage` and `ServerResponse`, emits the
   server's `'request'` event, and returns a promise.

### 4. The response comes back

When the request listener calls `res.end()`, the promise resolves with the
full response:

```js
{
  statusCode: 200,
  statusMessage: 'OK',
  headers: { 'content-type': 'application/json', ... },
  body: <Buffer>,
}
```

That object travels back through `interop_result` to the host's `invoke()`
promise. The host in the example above receives it about 2 seconds after the
server opened — a genuine round trip through the emulated stack, not a mock.

### What the response is and isn't

- **It is** a faithful trip through our ported `IncomingMessage` /
  `ServerResponse` state machines: status codes, header casing rules,
  chunked writes, and `finish` semantics all behave like Node.
- **It isn't** a network round trip: `req.socket` / `res.socket` are
  synthetic placeholders, there are no real connections, and `getConnections`
  is a stub. Client requests (`http.request` / `http.get`) go out over real
  `fetch()` instead — a different path from this one.

---

## Sandbox-internal globals (not interops)

These exist inside the sandbox but are never called across the boundary:

- `__syncRequire__` — the synchronous `require()` implementation, bound per
  module and reading through the live memfs `__FS__.readFileSync`
  (`src/sandbox/21-sync-require.js`).
- `__vitest_worker__` / `__vitest_index__` — safe-proxy mocks so vitest
  worker code never throws on missing config (`src/sandbox/05-vitest-mocks.js`).
