/**
 * Browser-compatible child_process shim
 * This version doesn't use just-bash and throws errors for commands
 * Most CLI tools (like Convex CLI) don't actually need shell execution
 */

import { EventEmitter } from "./events"
import { Readable, Writable } from "./stream"

/**
 * Initialize child_process - no-op in browser version
 */
export function initChildProcess() {
  // No-op - just-bash not used in browser version
}

/**
 * Execute a command in a shell
 */
export function exec(command, optionsOrCallback, callback) {
  let cb

  if (typeof optionsOrCallback === "function") {
    cb = optionsOrCallback
  } else {
    cb = callback
  }

  const child = new ChildProcess()

  // Execute asynchronously - emit error
  setTimeout(() => {
    const error = new Error(
      `exec is not supported in browser environment: ${command}`
    )
    child.emit("error", error)
    if (cb) cb(error, "", "")
  }, 0)

  return child
}

/**
 * Execute a command synchronously
 */
export function execSync(command, options) {
  throw new Error(
    `execSync is not supported in browser environment: ${command}`
  )
}

/**
 * Spawn a new process
 */
export function spawn(command, args, options) {
  const child = new ChildProcess()

  // Execute asynchronously - emit error
  setTimeout(() => {
    const error = new Error(
      `spawn is not supported in browser environment: ${command}`
    )
    child.emit("error", error)
  }, 0)

  return child
}

/**
 * Spawn a new process synchronously
 */
export function spawnSync(command, args, options) {
  throw new Error(
    `spawnSync is not supported in browser environment: ${command}`
  )
}

/**
 * Execute a file
 */
export function execFile(file, args, options, callback) {
  let cb

  if (typeof args === "function") {
    cb = args
  } else if (typeof options === "function") {
    cb = options
  } else {
    cb = callback
  }

  const child = new ChildProcess()

  setTimeout(() => {
    const error = new Error(
      `execFile is not supported in browser environment: ${file}`
    )
    child.emit("error", error)
    if (cb) cb(error, "", "")
  }, 0)

  return child
}

/**
 * Fork is not supported in browser
 */
export function fork() {
  throw new Error("fork is not supported in browser environment")
}

/**
 * ChildProcess class
 */
export class ChildProcess extends EventEmitter {
  connected = false
  killed = false
  exitCode = null
  signalCode = null
  spawnargs = []
  spawnfile = ""

  constructor() {
    super()
    this.pid = Math.floor(Math.random() * 10000) + 1000
    this.stdin = new Writable()
    this.stdout = new Readable()
    this.stderr = new Readable()
  }

  kill(signal) {
    this.killed = true
    this.emit("exit", null, signal || "SIGTERM")
    return true
  }

  disconnect() {
    this.connected = false
  }

  send(message, callback) {
    // IPC not supported
    if (callback) callback(new Error("IPC not supported"))
    return false
  }

  ref() {
    return this
  }

  unref() {
    return this
  }
}

export default {
  exec,
  execSync,
  execFile,
  spawn,
  spawnSync,
  fork,
  ChildProcess,
  initChildProcess
}
