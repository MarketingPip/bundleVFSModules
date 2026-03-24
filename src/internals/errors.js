'use strict';

/**
 * Browser-compatible Node.js Error System
 * Simplified for use in web environments.
 */

const kIsNodeError = Symbol('kIsNodeError');
const messages = new Map();
const codes = {};

// Helper to mimic Node's util.format in the browser
const format = (msg, ...args) => {
  let i = 0;
  return msg.replace(/%[dfijoOs]/g, () => String(args[i++]));
};

/**
 * Base NodeError logic to add the 'code' property and format messages
 */
function makeNodeErrorWithCode(Base, key) {
  return class NodeError extends Base {
    constructor(...args) {
      const msgTemplate = messages.get(key);
      const message = typeof msgTemplate === 'function' 
        ? msgTemplate(...args) 
        : (args.length > 0 ? format(msgTemplate, ...args) : msgTemplate);
      
      super(message);
      
      this.code = key;
      this[kIsNodeError] = true;

      if (Error.captureStackTrace) {
        Error.captureStackTrace(this, NodeError);
      }
    }

    get name() {
      return `${super.name} [${this.code}]`;
    }

    toString() {
      return `${this.name}: ${this.message}`;
    }
  };
}

/**
 * Register an Error Code
 * @param {string} sym Error Code (e.g., 'ERR_INVALID_ARG_TYPE')
 * @param {string|Function} val Message string or formatter function
 * @param {Error} def Base class (Error, TypeError, etc)
 */
function E(sym, val, def) {
  messages.set(sym, val);
  codes[sym] = makeNodeErrorWithCode(def, sym);
}

// --- Define some common Node.js errors for testing ---

E('ERR_INVALID_ARG_TYPE', (name, expected, actual) => {
  return `The "${name}" argument must be of type ${expected}. Received ${typeof actual}`;
}, TypeError);

E('ERR_METHOD_NOT_IMPLEMENTED', 'The %s method is not implemented', Error);

// --- Classes ---

class AbortError extends Error {
  constructor(message = 'The operation was aborted', options = undefined) {
    if (options !== undefined && typeof options !== 'object') {
      throw new codes.ERR_INVALID_ARG_TYPE('options', 'Object', options);
    }
    super(message, options);
    this.code = 'ABORT_ERR';
    this.name = 'AbortError';
  }
}

// --- Utilities ---

function determineSpecificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return `function ${value.name}`;
  if (Array.isArray(value)) return 'an instance of Array';
  return typeof value;
}

/**
 * Export for browser usage
 */
const errors = {
  codes,
  E,
  AbortError,
  determineSpecificType,
  kIsNodeError
};

// Example Usage:
// throw new errors.codes.ERR_INVALID_ARG_TYPE('options', 'Object', 123);

export default errors;
