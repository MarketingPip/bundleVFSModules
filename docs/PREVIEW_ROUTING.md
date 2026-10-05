# Preview Routing — real navigable URLs for guest servers

Guest servers in CodeSandbox are reachable programmatically (via patched
`fetch`), but not navigable — you can't type the URL in the address bar,
embed it in an iframe, or open it in a new tab. Preview routing fixes that
with a Service Worker at `/__virtual__/{port}/`.

## URL scheme

```
http://localhost:8000/__virtual__/3000/api/users
                         └─┬─┘ └┬┘ └────┬─────┘
                     prefix  port   path on the guest server
```

The port is the guest server's port (the one passed to `server.listen()`).
The path is forwarded verbatim to the guest server.

## Usage (host page)

```js
import {
  registerPreviewSW,
  handlePreviewMessage,
} from "./src/plugins/preview-routing.js";

// 1. Register the Service Worker (once, at host startup).
await registerPreviewSW();

// 2. Forward SW messages to your sandbox.
navigator.serviceWorker.addEventListener("message", (event) => {
  handlePreviewMessage(event, mySandbox);
});
```

Or as a plugin (exposes helpers, does not auto-register):

```js
import { previewRoutingPlugin } from "./src/plugins/preview-routing.js";
import { registerPlugin } from "./src/plugins.js";
registerPlugin(previewRoutingPlugin);
```

## Architecture

```
browser navigation to /__virtual__/3000/path
        │ Service Worker fetch handler (src/preview-sw.js)
        │ postMessage via MessageChannel
        ▼ host page
  handlePreviewMessage(event, sandbox)
        │ sandbox.handlePreviewRequest() or __httpServerRunTime.handleRequest
        ▼ guest server in the iframe
  HTTP response bubbles back through the same channel
```

## Error handling (`forwardPreviewErrors` pattern)

- No server on the port → **502** with `Preview routing failed for port {port}: ...`
- SW timeout (30s) → **502** with timeout message.
- The SW never hangs a navigation; every failure becomes a 502 with a
  clear message.

## Limitations (honest)

- **HTTPS or localhost only.** Service Workers are a spec-level requirement;
  `file://` and plain HTTP (non-localhost) cannot register one.
- **First-load race.** The SW takes control on the second navigation.
  The host should reload after registration or wait for
  `navigator.serviceWorker.controllerchange`.
- **Scope.** The SW is scoped to `/__virtual__/` and never intercepts the
  host app's own routes.
- **No auto-registration.** The plugin exposes helpers but never calls
  `registerPreviewSW()` itself — SW registration has page-wide side
  effects and requires explicit host opt-in.
