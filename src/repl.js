import readline from './readline-polyfill.js'; // your readline shim

const repl = (function () {
  class REPLServer {
    constructor(options = {}) {
      this.input = options.input || readline;
      this.output = options.output || console;
      this.promptStr = options.prompt || '> ';
      this.eval = options.eval || ((cmd, context, filename, cb) => {
        try {
          const result = eval(cmd);
          cb(null, result);
        } catch (err) {
          cb(err);
        }
      });
      this.writer = options.writer || (x => typeof x === 'string' ? x : JSON.stringify(x, null, 2));
      this.commands = {};
      this.bufferedCommand = '';
      this.closed = false;
      this._ev = Object.create(null);

      // Attach keypress events if supported
      if (this.input.emitKeypressEvents) this.input.emitKeypressEvents(this.input);

      // Setup basic line handling
      this.input.on('line', line => this._handleLine(line));
    }

    _handleLine(line) {
      line = line.trim();
      if (!line) return this.displayPrompt();

      if (line.startsWith('.') && this.commands[line.split(' ')[0]]) {
        const cmd = line.split(' ')[0];
        this.commands[cmd].action(line.slice(cmd.length).trim());
        return;
      }

      // Multi-line support placeholder (noop in browser)
      const code = this.bufferedCommand + line;
      this.bufferedCommand = '';

      this.eval(code, {}, '', (err, result) => {
        if (err) this.output.error?.(err) || console.error(err);
        else this.output.log(this.writer(result));
        this.displayPrompt();
      });
    }

    displayPrompt(preserveCursor) {
      if (!this.closed) this.output.write?.(this.promptStr);
    }

    defineCommand(keyword, cmd) {
      if (!cmd || typeof cmd.action !== 'function') return;
      this.commands['.' + keyword] = cmd;
    }

    clearBufferedCommand() {
      this.bufferedCommand = '';
    }

    on(event, listener) {
      if (!this._ev[event]) this._ev[event] = [];
      this._ev[event].push(listener);
      return this;
    }

    emit(event, ...args) {
      (this._ev[event] || []).forEach(fn => fn(...args));
      return true;
    }

    removeListener(event, listener) {
      if (!this._ev[event]) return this;
      this._ev[event] = this._ev[event].filter(fn => fn !== listener);
      return this;
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit('exit');
    }
  }

  function start(options = {}) {
    const server = new REPLServer(options);
    server.displayPrompt();
    server.defineCommand('exit', {
      help: 'Exit the REPL',
      action() {
        server.close();
      }
    });
    return server;
  }

  return { start, REPLServer };
})();

export default repl;
