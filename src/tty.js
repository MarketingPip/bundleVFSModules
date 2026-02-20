/**
 * Node.js tty module shim
 * Provides terminal detection utilities
 */

import { Readable, Writable } from "stream"

export class ReadStream extends Readable {
  isTTY = false
  isRaw = false

  setRawMode(mode) {
    this.isRaw = mode
    return this
  }
}

export class WriteStream extends Writable {
  isTTY = false
  columns = 80
  rows = 24

  clearLine(dir, callback) {
    if (callback) callback()
    return true
  }

  clearScreenDown(callback) {
    if (callback) callback()
    return true
  }

  cursorTo(x, y, callback) {
    if (callback) callback()
    return true
  }

  moveCursor(dx, dy, callback) {
    if (callback) callback()
    return true
  }

  getColorDepth(env) {
    return 1 // No color support in browser
  }

  hasColors(count, env) {
    return false
  }

  getWindowSize() {
    return [this.columns, this.rows]
  }
}

export function isatty(fd) {
  return false // Browser is never a TTY
}

export default {
  ReadStream,
  WriteStream,
  isatty
}
