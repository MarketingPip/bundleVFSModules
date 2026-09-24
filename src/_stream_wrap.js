// node:_stream_wrap — Node internal module, deprecated upstream (DEP0125).
//
// Real Node exports the StreamWrap constructor (legacy handle wrapping for
// old-style streams). There is no browser equivalent, so this is a minimal
// shape-preserving stub: constructing it records the wrapped stream and does
// nothing else. Never throws.
// Dependency-free ESM, browser-safe. No _RUNTIME_ access needed.
function StreamWrap(stream) {
  if (!(this instanceof StreamWrap)) return new StreamWrap(stream);
  this.stream = stream ?? null;
}
StreamWrap.StreamWrap = StreamWrap;
export default StreamWrap;
