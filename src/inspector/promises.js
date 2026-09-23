// src/inspector/promises.js — port of node:inspector/promises for the browser runtime.
//
// Mirrors Node v24.20.0's lib/inspector/promises.js exactly: every export of
// node:inspector is re-exported unchanged, and Session is a subclass whose
// post() returns a promise for the result. Same honesty caveat as
// ../inspector.js: no DevTools protocol runs in the sandbox, so post()
// resolves an empty result object {} — a documented noop, not fabricated
// protocol data.
//
// There is deliberately NO default export: real node:inspector/promises is a
// CJS module whose require() returns the exports object itself, and Node's
// CJS→ESM loader creates a facade copy whenever a default export exists.
// Omitting it keeps the CJS-style loading behaviour aligned with real Node
// (same convention as src/dns/promises.js).

import {
  Session as CallbackSession,
  open,
  close,
  url,
  waitForDebugger,
  console as inspectorConsole,
  Network,
  DOMStorage,
  NetworkResources,
} from "../inspector.js";

// Like Node (class Session extends inspector.Session {} with a promisified
// post), connect()/disconnect()/connectToMainThread() are inherited noops.
export class Session extends CallbackSession {
  post(method, params) {
    return new Promise((resolve, reject) => {
      super.post(method, params, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }
}

export { open, close, url, waitForDebugger };
export { inspectorConsole as console };
export { Network, DOMStorage, NetworkResources };
