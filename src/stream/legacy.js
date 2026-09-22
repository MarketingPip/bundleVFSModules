import {

  ArrayIsArray,
  ObjectSetPrototypeOf,
  ReflectOwnKeys,
} from './primordials.js';
import { EventEmitter } from '../events.js';






function Stream(opts) {
  // The repo's EventEmitter is an ES class (not .call()-able); its static
  // init() performs the same per-instance initialization.
  // NB: do not forward stream `signal` to EventEmitter — the repo's
  // EventEmitter removes all listeners on abort, but Node's streams keep
  // theirs (abort is handled via addAbortSignal -> destroy).
  const { signal: _signal, ...eeOpts } = opts ?? {};
  EventEmitter.init.call(this, eeOpts);
}
ObjectSetPrototypeOf(Stream.prototype, EventEmitter.prototype);
ObjectSetPrototypeOf(Stream, EventEmitter);

Stream.prototype.pipe = function(dest, options) {
  const source = this;

  function ondata(chunk) {
    if (dest.writable && dest.write(chunk) === false && source.pause) {
      source.pause();
    }
  }

  source.on('data', ondata);

  function ondrain() {
    if (source.readable && source.resume) {
      source.resume();
    }
  }

  dest.on('drain', ondrain);

  // If the 'end' option is not supplied, dest.end() will be called when
  // source gets the 'end' or 'close' events.  Only dest.end() once.
  if (!dest._isStdio && (!options || options.end !== false)) {
    source.on('end', onend);
    source.on('close', onclose);
  }

  let didOnEnd = false;
  function onend() {
    if (didOnEnd) return;
    didOnEnd = true;

    dest.end();
  }


  function onclose() {
    if (didOnEnd) return;
    didOnEnd = true;

    if (typeof dest.destroy === 'function') dest.destroy();
  }

  // Don't leave dangling pipes when there are errors.
  function onerror(er) {
    cleanup();
    // If we removed the last error handler, trigger an unhandled error event.
    if (this.listenerCount?.('error') === 0) {
      this.emit('error', er);
    }
  }

  prependListener(source, 'error', onerror);
  prependListener(dest, 'error', onerror);

  // Remove all the event listeners that were added.
  function cleanup() {
    source.removeListener('data', ondata);
    dest.removeListener('drain', ondrain);

    source.removeListener('end', onend);
    source.removeListener('close', onclose);

    source.removeListener('error', onerror);
    dest.removeListener('error', onerror);

    source.removeListener('end', cleanup);
    source.removeListener('close', cleanup);

    dest.removeListener('close', cleanup);
  }

  source.on('end', cleanup);
  source.on('close', cleanup);

  dest.on('close', cleanup);
  dest.emit('pipe', source);

  // Allow for unix-like usage: A.pipe(B).pipe(C)
  return dest;
};

Stream.prototype.eventNames = function eventNames() {
  const names = [];
  for (const key of ReflectOwnKeys(this._events)) {
    if (typeof this._events[key] === 'function' || (ArrayIsArray(this._events[key]) && this._events[key].length > 0)) {
      names.push(key);
    }
  }
  return names;
};

function prependListener(emitter, event, fn) {
  // Sadly this is not cacheable as some libraries bundle their own
  // event emitter implementation with them.
  if (typeof emitter.prependListener === 'function')
    return emitter.prependListener(event, fn);

  // This is a hack to make sure that our error handler is attached before any
  // userland ones.  NEVER DO THIS. This is here only because this code needs
  // to continue to work with older versions of Node.js that do not include
  // the prependListener() method. The goal is to eventually remove this hack.
  if (!emitter._events || !emitter._events[event])
    emitter.on(event, fn);
  else if (ArrayIsArray(emitter._events[event]))
    emitter._events[event].unshift(fn);
  else
    emitter._events[event] = [fn, emitter._events[event]];
}

export { Stream, prependListener };
