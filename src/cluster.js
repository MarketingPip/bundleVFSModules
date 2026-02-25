/**
 * Browser Cluster Shim
 * API-compatible with Node.js cluster (behaviorally simulated)
 */

import { EventEmitter } from "./events"

/* ------------------------------------------------ */
/* Role flags (browser always acts as primary)     */
/* ------------------------------------------------ */

export const isPrimary = true
export const isMaster = true // deprecated alias
export const isWorker = false

/* ------------------------------------------------ */
/* Internal State                                  */
/* ------------------------------------------------ */

let nextWorkerId = 1

export const workers = {}
export let worker = undefined

export const settings = {}

export const SCHED_NONE = 1
export const SCHED_RR = 2
export let schedulingPolicy = SCHED_RR

const clusterEmitter = new EventEmitter()

/* ------------------------------------------------ */
/* Worker Class                                    */
/* ------------------------------------------------ */

export class Worker extends EventEmitter {
  exitedAfterDisconnect = false

  _connected = true
  _dead = false

  constructor(env) {
    super()

    this.id = nextWorkerId++

    this.process = {
      pid: this.id,
      env: env || {},
      connected: true,
      kill: signal => this.kill(signal)
    }

    workers[this.id] = this
  }

  /* -------------------------------------------- */
  /* IPC simulation                              */
  /* -------------------------------------------- */

  send(message, callback) {
    if (!this._connected || this._dead) return false

    // simulate async message delivery
    setTimeout(() => {
      this.emit("message", message)
      clusterEmitter.emit("message", this, message)
      callback?.(null)
    }, 0)

    return true
  }

  /* -------------------------------------------- */
  /* Lifecycle                                    */
  /* -------------------------------------------- */

  isConnected() {
    return this._connected
  }

  isDead() {
    return this._dead
  }

  disconnect() {
    if (!this._connected || this._dead) return

    this._connected = false
    this.process.connected = false
    this.exitedAfterDisconnect = true

    this.emit("disconnect")
    clusterEmitter.emit("disconnect", this)

    // simulate graceful exit
    setTimeout(() => {
      this._finalizeExit(0, null)
    }, 0)
  }

  kill(signal = "SIGTERM") {
    if (this._dead) return
    this._connected = false
    this.process.connected = false

    this._finalizeExit(0, signal)
  }

  _finalizeExit(code, signal) {
    if (this._dead) return

    this._dead = true

    delete workers[this.id]

    this.emit("exit", code, signal)
    clusterEmitter.emit("exit", this, code, signal)
  }
}

/* ------------------------------------------------ */
/* Fork                                            */
/* ------------------------------------------------ */

export function fork(env) {
  const w = new Worker(env)

  clusterEmitter.emit("fork", w)

  // simulate worker becoming online
  setTimeout(() => {
    w.emit("online")
    clusterEmitter.emit("online", w)
  }, 0)

  return w
}

/* ------------------------------------------------ */
/* Cluster-wide disconnect                         */
/* ------------------------------------------------ */

export function disconnect(callback) {
  const activeWorkers = Object.values(workers)

  activeWorkers.forEach(w => w.disconnect())

  if (callback) setTimeout(callback, 0)
}

/* ------------------------------------------------ */
/* Setup                                           */
/* ------------------------------------------------ */

export function setupPrimary(newSettings) {
  if (newSettings) Object.assign(settings, newSettings)
  clusterEmitter.emit("setup", settings)
}

export const setupMaster = setupPrimary

/* ------------------------------------------------ */
/* Event API (cluster-level)                       */
/* ------------------------------------------------ */

export const on = clusterEmitter.on.bind(clusterEmitter)
export const once = clusterEmitter.once.bind(clusterEmitter)
export const emit = clusterEmitter.emit.bind(clusterEmitter)
export const removeListener = clusterEmitter.removeListener.bind(clusterEmitter)

/* ------------------------------------------------ */
/* Default Export                                  */
/* ------------------------------------------------ */

export default {
  isPrimary,
  isMaster,
  isWorker,
  Worker,
  worker,
  workers,
  fork,
  disconnect,
  settings,
  SCHED_NONE,
  SCHED_RR,
  schedulingPolicy,
  setupPrimary,
  setupMaster,
  on,
  once,
  emit,
  removeListener
}
