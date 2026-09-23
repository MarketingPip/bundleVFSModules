// Minimal browser-safe AsyncResource for stream internals.
//
// Node's internal/streams/end-of-stream.js uses AsyncResource only to bind
// the end-of-stream callback via resource.runInAsyncScope(). Without native
// async_hooks there is no async context to track, so runInAsyncScope simply
// invokes the function (identity semantics). This keeps the stream port
// dependency-free; it does not replace the repo's src/async_hooks.js port.
export class AsyncResource {
  constructor(type) {
    this._type = type;
  }
  runInAsyncScope(fn, thisArg, ...args) {
    return fn.apply(thisArg, args);
  }
  emitDestroy() {
    return this;
  }
}
