/**
 * Node.js domain module shim
 * The domain module is deprecated but some packages still use it
 */

import { EventEmitter } from "./events"

export class Domain extends EventEmitter {
  members = []

  add(emitter) {
    this.members.push(emitter)
  }

  remove(emitter) {
    const index = this.members.indexOf(emitter)
    if (index !== -1) {
      this.members.splice(index, 1)
    }
  }

  bind(callback) {
    return callback
  }

  intercept(callback) {
    return callback
  }

  run(fn) {
    return fn()
  }

  dispose() {
    this.members = []
  }

  enter() {
    // Stub
  }

  exit() {
    // Stub
  }
}

export function create() {
  return new Domain()
}

// Active domain (deprecated but some packages check for it)
export let active = null

export default {
  Domain,
  create,
  active
}
