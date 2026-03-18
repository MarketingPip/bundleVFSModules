//import BrowserStdout from 'browser-stdout';

//export default browserStdout({ label: false });

class EventEmitter {
  constructor() { this._events = {}; }
  on(type, listener) {
    (this._events[type] || (this._events[type] = [])).push(listener);
    return this;
  }
  emit(type, ...args) {
    if (!this._events[type]) return false;
    this._events[type].forEach(fn => fn.apply(this, args));
    return true;
  }
  once(type, listener) {
    const selfClosing = (...args) => {
      this.off(type, selfClosing);
      listener.apply(this, args);
    };
    return this.on(type, selfClosing);
  }
  off(type, listener) {
    if (!this._events[type]) return this;
    this._events[type] = this._events[type].filter(fn => fn !== listener);
    return this;
  }
}
// Alias for Node compliance
EventEmitter.prototype.addListener = EventEmitter.prototype.on;
EventEmitter.prototype.removeListener = EventEmitter.prototype.off;


function _makeOutputShim(name) {
  const stream = new EventEmitter();
  let _buffer = ''; // Internal storage for partial lines

  Object.assign(stream, {
    isTTY: true,
    writable: true,
    fd: name === 'stderr' ? 2 : 1,
    columns: 80,
    rows: 24,
    write(chunk) {
      const str = Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
      _buffer += str;

      // Split by newline and handle each complete line
      const lines = _buffer.split('\n');
      
      // The last element is either an empty string (if ended in \n) 
      // or a partial line (if it didn't). Keep it for next time.
      _buffer = lines.pop(); 

      lines.forEach(line => {
        console[name === 'stderr' ? 'error' : 'log'](line);
      });

      return true;
    },
    end() {
      // If there is anything left in the buffer when ending, flush it
      if (_buffer) {
        console[name === 'stderr' ? 'error' : 'log'](_buffer);
        _buffer = '';
      }
      this.emit('finish');
    },
    destroy() {
      _buffer = '';
    }
  });
  return stream;
}
export default _makeOutputShim;
