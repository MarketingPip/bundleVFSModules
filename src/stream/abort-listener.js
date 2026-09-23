// Port of Node v24.20.0 lib/internal/events/abort_listener.js.
// queueMicrotask is a host global (Node and browsers); the
// kResistStopPropagation symbol comes from ./event-target.js.
import {
  ObjectFreeze,
  SymbolDispose,
} from './primordials.js';
import {
  validateAbortSignal,
  validateFunction,
} from './validators.js';
import { codes } from './errors.js';
import { kResistStopPropagation } from './event-target.js';

const { ERR_INVALID_ARG_TYPE } = codes;

let abortListenerOptions;

/**
 * @param {AbortSignal} signal
 * @param {EventListener} listener
 * @returns {Disposable}
 */
function addAbortListener(signal, listener) {
  if (signal === undefined) {
    throw new ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
  }
  validateAbortSignal(signal, 'signal');
  validateFunction(listener, 'listener');

  let removeEventListener;
  if (signal.aborted) {
    queueMicrotask(() => listener());
  } else {
    abortListenerOptions ??= ObjectFreeze({ __proto__: null, once: true, [kResistStopPropagation]: true });
    signal.addEventListener('abort', listener, abortListenerOptions);
    removeEventListener = () => {
      signal.removeEventListener('abort', listener);
    };
  }
  return {
    __proto__: null,
    [SymbolDispose]() {
      removeEventListener?.();
    },
  };
}

export {
  addAbortListener,
};
