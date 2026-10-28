# NOTES — createServer({ IncomingMessage }) honored (Lane 3)

## Test
`test-http-server-options-incoming-message`: was exit 124 (hang) on main
4f8e6431, now exit 0.

## Real-Node behavior probed (Node v24.22.1, before implementing)
- `http.createServer({ IncomingMessage: Sub })` delivers `req instanceof
  Sub` (and still `instanceof http.IncomingMessage`), `req.constructor.name
  === "Sub"`, and the subclass's custom method works.
- The subclass constructor receives exactly one argument: the socket.
- With no option, req is a plain `http.IncomingMessage` with no custom
  methods — the default path is unchanged.
- Invalid value (`IncomingMessage: 42`): real Node does NOT validate — the
  process dies at first request with `TypeError: ParserIncomingMessage is
  not a constructor` (from the parser's message construction). No official
  test covers invalid values, so the shim deliberately deviates here: a
  non-function option falls back to the default class instead of taking
  the whole page down. Documented, not hidden.

## Root cause in plain terms
`ServerBase` stored the timeout options but never stored `IncomingMessage`,
and `_dispatchSocketRequest` hardcoded `new IncomingMessage(socket)`. So a
server created with a custom message class still delivered plain messages:
the test handler's `req.getUserAgent()` threw before `res.end()`, the throw
was routed to `clientError` (unlistened, so swallowed) plus
`socket.destroy()`, and no response was ever written — the client hung.

## Fix (src/http.js only, +10 lines)
- `ServerBase` constructor stores `options.IncomingMessage` raw as
  `this._incomingMessageClass`.
- `_dispatchSocketRequest` instantiates it when it is a function, else the
  default `IncomingMessage`. Because req is built before the upgrade check,
  the server-side `upgrade` event also receives the subclass instance, as
  in real Node (one message object per request).

## Deliberately out of scope
- The swallowed-throw mechanism (`clientError` + destroy on handler throw)
  was NOT changed: once req is the right class, the handler succeeds and
  the test passes without touching it.
- `ServerResponse` option: real Node supports it too, but no in-scope test
  exercises it; separate lane if one appears.
- `handleRequest` (runtime-bridge synthetic path) still uses
  `IncomingMessage.fromRequest` — it has no socket and is not a
  parser-created server request, so the option does not apply there.
- Invalid `IncomingMessage` values fall back to default (see probe note
  above) rather than replicating real Node's process crash.
