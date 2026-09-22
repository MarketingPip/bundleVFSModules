// Parity adapter for `require('internal/event_target')` used by the official
// Node events tests (test-events-customevent.js,
// test-events-on-async-iterator.js, test-events-static-geteventlisteners.js).
//
// In real Node, `internal/event_target` requires `--expose-internals`. The
// tests only need the public web-API classes plus a few symbols, so this
// adapter re-exports the real globals:
//   - `Event`, `EventTarget`, `CustomEvent`: the real global classes.
//   - `NodeEventTarget`: a plain subclass (the tests only subclass it).
//   - `kEvents`: the REAL symbol, discovered from a probe instance by symbol
//     description, so `signal[kEvents]` reads Node's real listener map.
//   - `kWeakHandler`: a local stand-in symbol. The tests add weak listeners
//     via the `weak: true` option and read them back through the real
//     `kEvents` map; the symbol's identity is never asserted.

const probe = new AbortController().signal;
const kEvents = Object.getOwnPropertySymbols(probe).find(
  (s) => s.description === 'kEvents',
);

export const Event = globalThis.Event;
export const EventTarget = globalThis.EventTarget;
export const CustomEvent = globalThis.CustomEvent;
export class NodeEventTarget extends EventTarget {}
export { kEvents };
export const kWeakHandler = Symbol('kWeakHandler');
