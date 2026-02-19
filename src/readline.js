const readline = (function () {

  const rl = {};

  rl.emitKeypressEvents = function (stream) {
    if (!stream || stream._keypressAttached) return;
    stream._keypressAttached = true;
  };

  rl.createInterface = function (options = {}) {

    const input = options.input || process.stdin;
    const output = options.output || process.stdout;
    const terminal = options.terminal != null ? !!options.terminal : !!output.isTTY;

    const _ev = Object.create(null);

    function _on(ev, fn, once = false) {
      if (!_ev[ev]) _ev[ev] = [];
      _ev[ev].push({ fn, once });
      return iface;
    }

    function _off(ev, fn) {
      if (_ev[ev]) _ev[ev] = _ev[ev].filter(e => e.fn !== fn);
      return iface;
    }

    function _emit(ev, ...args) {
      const list = _ev[ev]; if (!list) return false;
      const snap = [...list];
      _ev[ev] = list.filter(e => !e.once);
      for (const e of snap) e.fn(...args);
      return true;
    }

    function _listenerCount(ev) { return (_ev[ev] || []).length; }

    let iface;

    let promptStr = options.prompt || (terminal ? '> ' : '');
    let closed = false;
    let lineBuffer = "";
    let crSeen = false;

    function _handleChunk(chunk) {
      const str = typeof chunk === 'string' ? chunk : chunk.toString();
      if (input.isRaw || terminal) {
        const line = str.replace(/[\r\n]+$/, '');
        if (line === '\u0003') { _emit('SIGINT'); return; }
        _emit('line', line);
      } else {
        for (let i = 0; i < str.length; i++) {
          const ch = str[i];
          if (ch === '\r') { crSeen = true; _flushLine(); continue; }
          if (ch === '\n') { if (!crSeen) _flushLine(); crSeen = false; continue; }
          crSeen = false;
          lineBuffer += ch;
        }
      }
    }

    function _flushLine() {
      const line = lineBuffer;
      lineBuffer = "";
      if (line === '\u0003') { _emit('SIGINT'); return; }
      _emit('line', line);
    }

    input.on('data', _handleChunk);
    input.on('close', () => { if (!closed) iface.close(); });

    const _lineQueue = [];
    let _lineResolve = null;
    let _lineDone = false;

    _on('line', line => {
      if (_lineResolve) {
        const r = _lineResolve;
        _lineResolve = null;
        r({ value: line, done: false });
      } else {
        _lineQueue.push(line);
      }
    });

    _on('close', () => {
      _lineDone = true;
      if (_lineResolve) {
        _lineResolve({ value: undefined, done: true });
        _lineResolve = null;
      }
    });

    iface = {

      terminal,

      on(ev, fn) { return _on(ev, fn, false); },
      once(ev, fn) { return _on(ev, fn, true); },
      off(ev, fn) { return _off(ev, fn); },
      removeListener(ev, fn) { return _off(ev, fn); },
      removeAllListeners(ev) {
        if (ev) delete _ev[ev]; else Object.keys(_ev).forEach(k => delete _ev[k]);
        return this;
      },
      listenerCount(ev) { return _listenerCount(ev); },
      emit(ev, ...a) { return _emit(ev, ...a); },

      setPrompt(str) { promptStr = str; return this; },
      getPrompt() { return promptStr; },
      prompt(preserveCursor) {
        if (output && output.write) output.write(promptStr);
        return this;
      },

      pause() {
        if (input.pause) input.pause();
        _emit('pause');
        return this;
      },
      resume() {
        if (input.resume) input.resume();
        _emit('resume');
        return this;
      },

      close() {
        if (closed) return this;
        closed = true;
        input.off('data', _handleChunk);
        _emit('close');
        setTimeout(() => {
          if (input.listenerCount('data') === 0) {
            if (input.end) input.end();
          }
        }, 0);
        return this;
      },

      write(data, key) {
        if (closed) return this;
        if (typeof data === 'string' && data.length)
          _emit('line', data.replace(/[\r\n]+$/, ''));
        return this;
      },

      question(query, optionsOrCb, cb) {
        if (closed) return typeof cb === 'function' || typeof optionsOrCb === 'function'
          ? void 0 : Promise.reject(new Error('readline was closed'));

        let opts = {}, callback;
        if (typeof optionsOrCb === 'function') {
          callback = optionsOrCb;
        } else {
          opts = optionsOrCb || {};
          callback = cb;
        }

        if (output && output.write) output.write(query);

        const signal = opts.signal;

        if (typeof callback === 'function') {
          let called = false;
          const onLine = answer => {
            if (called) return; called = true;
            _off('line', onLine);
            callback(answer);
          };
          const onAbort = () => {
            if (called) return; called = true;
            _off('line', onLine);
          };
          _on('line', onLine);
          if (signal) signal.addEventListener('abort', onAbort, { once: true });
          return this;
        }

        return new Promise((resolve, reject) => {
          let settled = false;
          const onLine = answer => {
            if (settled) return; settled = true;
            _off('line', onLine);
            resolve(answer);
          };
          const onAbort = () => {
            if (settled) return; settled = true;
            _off('line', onLine);
            const err = new Error('The question was aborted');
            err.code = 'ABORT_ERR';
            reject(err);
          };
          _on('line', onLine);
          if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
      },

      [Symbol.asyncIterator]() {
        return {
          next() {
            if (_lineQueue.length)
              return Promise.resolve({ value: _lineQueue.shift(), done: false });
            if (_lineDone)
              return Promise.resolve({ value: undefined, done: true });
            return new Promise(res => { _lineResolve = res; });
          },
          return() {
            return Promise.resolve({ value: undefined, done: true });
          }
        };
      }
    };

    return iface;
  };

  rl.cursorTo = function (stream, x, y, cb) {
    if (y == null) stream.write(`\u001b[${x + 1}G`);
    else stream.write(`\u001b[${y + 1};${x + 1}H`);
    if (cb) cb();
    return true;
  };

  rl.moveCursor = function (stream, dx, dy, cb) {
    if (dx > 0) stream.write(`\u001b[${dx}C`);
    if (dx < 0) stream.write(`\u001b[${-dx}D`);
    if (dy > 0) stream.write(`\u001b[${dy}B`);
    if (dy < 0) stream.write(`\u001b[${-dy}A`);
    if (cb) cb();
    return true;
  };

  rl.clearLine = function (stream, dir, cb) {
    const code = dir === 0 ? 2 : dir === -1 ? 1 : 0;
    stream.write(`\u001b[${code}K`);
    if (cb) cb();
    return true;
  };

  rl.clearScreenDown = function (stream, cb) {
    stream.write('\u001b[0J');
    if (cb) cb();
    return true;
  };

  globalThis.readline = rl;
  return rl;

})();

export default readline;
