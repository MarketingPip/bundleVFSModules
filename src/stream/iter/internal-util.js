// Shim for the three `internal/util` helpers the stream/iter port needs,
// plus the `internalBinding('util').markPromiseAsHandled` binding.
// (Node v26.13.1 lib/internal/util.js; semantics preserved, browser-safe.)
//
// - isError: Node checks native-error brand OR instanceof Error (cross-realm
//   safe). The shim's Error brand check is `instanceof Error` plus the
//   DOMException brand, which covers the classic.js toClassicError use.
// - lazyDOMException(message, name): Node lazily loads the DOMException
//   class; here the global is used directly.
// - emitExperimentalWarning(feature): once-per-feature
//   `ExperimentalWarning` via process.emitWarning when available (parity
//   host), silent no-op in the browser sandbox where there is no process.
// - markPromiseAsHandled(promise): Node marks the promise handled without
//   attaching a visible handler; the observable equivalent is attaching a
//   no-op rejection handler so an expected rejection never surfaces as
//   unhandled.

function isError(e) {
  if (e instanceof Error) return true;
  if (typeof DOMException !== "undefined" && e instanceof DOMException)
    return true;
  return false;
}

function lazyDOMException(message, name) {
  return new DOMException(message, name);
}

const warnedFeatures = new Set();
function emitExperimentalWarning(feature, messagePrefix, code) {
  if (warnedFeatures.has(feature)) return;
  warnedFeatures.add(feature);
  let msg = `${feature} is an experimental feature and might change at any time`;
  if (messagePrefix) {
    msg = messagePrefix + msg;
  }
  if (
    typeof process !== "undefined" &&
    typeof process.emitWarning === "function"
  ) {
    process.emitWarning(msg, "ExperimentalWarning", code);
  }
}

function markPromiseAsHandled(promise) {
  // ponytail: attaching a no-op catch is the observable equivalent of
  // Node's internal mark — an expected rejection must not surface as
  // unhandled, and no extra work is scheduled for fulfilled promises.
  promise.catch(() => {});
}

// - abortWithReason(controller, reason): Node's internal abortSignal()
//   (lib/internal/abort_controller.js:501) sets the signal's reason to
//   `reason` verbatim — including `undefined` (a transform that throws
//   undefined must abort its pipeline signal with reason undefined, per
//   test-stream-iter-reason-propagation.js). The public
//   AbortController.abort(undefined) instead substitutes a default
//   AbortError DOMException. The shim shadows the prototype `reason`
//   getter with an own data property before aborting, so every reader
//   (listeners, `.reason` checks) sees the verbatim reason while
//   `.aborted` and the abort event behave normally.
//   Ceiling: `signal.throwIfAborted()` still throws the host's default
//   AbortError (it reads the internal slot, not the shadow). No tested
//   path calls throwIfAborted() on a signal aborted with an undefined
//   reason — the pipeline rethrows the transform's error first — but a
//   future path that does would see AbortError instead of undefined.
function abortWithReason(controller, reason) {
  if (reason === undefined) {
    try {
      Object.defineProperty(controller.signal, "reason", {
        __proto__: null,
        value: undefined,
        configurable: true,
      });
    } catch {
      // A frozen/non-extensible signal (never observed on the host) falls
      // back to the default AbortError reason.
    }
  }
  controller.abort(reason);
}

export {
  abortWithReason,
  emitExperimentalWarning,
  isError,
  lazyDOMException,
  markPromiseAsHandled,
};
