// Node.js internal error builders for node:timers — ported from Node v24.20.0
// lib/internal/errors.js and lib/internal/validators.js.
//
// Dependency-free ESM. Only the error shapes used by timers/timers/promises
// are included: ERR_INVALID_ARG_TYPE, ERR_ILLEGAL_CONSTRUCTOR,
// ERR_INVALID_THIS, and AbortError (ABORT_ERR), plus the validators.

// ---------------------------------------------------------------------------
// determineSpecificType — mirrors Node's internal/errors.js
// ---------------------------------------------------------------------------

function determineSpecificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  switch (type) {
    case 'bigint':
      return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      if (value !== value) return 'type number (NaN)'; // eslint-disable-line no-self-compare
      if (value === Infinity) return 'type number (Infinity)';
      if (value === -Infinity) return 'type number (-Infinity)';
      return `type number (${value})`;
    case 'boolean':
      return value ? 'type boolean (true)' : 'type boolean (false)';
    case 'symbol':
      return `type symbol (${String(value)})`;
    case 'function':
      return `function ${value.name}`;
    case 'object':
      if (value.constructor && 'name' in value.constructor) {
        return `an instance of ${value.constructor.name}`;
      }
      return 'an instance of Object';
    case 'string': {
      let s = value;
      if (s.length > 28) s = `${s.slice(0, 25)}...`;
      if (!s.includes("'")) return `type string ('${s}')`;
      return `type string (${JSON.stringify(s)})`;
    }
    default:
      return `type ${type} (${String(value)})`;
  }
}

// ---------------------------------------------------------------------------
// ERR_INVALID_ARG_TYPE message builder — mirrors Node's internal/errors.js
// ---------------------------------------------------------------------------

const kTypes = [
  'string', 'function', 'number', 'object',
  'Function', 'Object', 'boolean', 'bigint', 'symbol',
];
const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;

function formatList(list) {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;
}

function invalidArgTypeMessage(name, expected, actual) {
  if (!Array.isArray(expected)) expected = [expected];
  let msg = 'The ';
  if (name.endsWith(' argument')) {
    msg += `${name} `;
  } else {
    msg += `"${name}" ${name.includes('.') ? 'property' : 'argument'} `;
  }
  msg += 'must be ';

  const types = [];
  const instances = [];
  const other = [];
  for (const value of expected) {
    if (kTypes.includes(value)) {
      types.push(value.toLowerCase());
    } else if (classRegExp.test(value)) {
      instances.push(value);
    } else {
      other.push(value);
    }
  }

  if (instances.length > 0) {
    const pos = types.indexOf('object');
    if (pos !== -1) {
      types.splice(pos, 1);
      instances.push('Object');
    }
  }

  if (types.length > 0) {
    msg += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types)}`;
    if (instances.length > 0 || other.length > 0) msg += ' or ';
  }
  if (instances.length > 0) {
    msg += `an instance of ${formatList(instances)}`;
    if (other.length > 0) msg += ' or ';
  }
  if (other.length > 0) {
    if (other.length > 1) {
      msg += `one of ${formatList(other)}`;
    } else {
      if (other[0].toLowerCase() !== other[0]) msg += 'an ';
      msg += `${other[0]}`;
    }
  }

  msg += `. Received ${determineSpecificType(actual)}`;
  return msg;
}

// Give errors Node's `TypeError [CODE]: message` stringification.
function withCode(err, code) {
  err.code = code;
  Object.defineProperty(err, 'toString', {
    value() { return `${this.constructor.name} [${code}]: ${this.message}`; },
    configurable: true,
    writable: true,
    enumerable: false,
  });
  return err;
}

export function ERR_INVALID_ARG_TYPE(name, expected, actual) {
  return withCode(
    new TypeError(invalidArgTypeMessage(name, expected, actual)),
    'ERR_INVALID_ARG_TYPE',
  );
}

export function ERR_ILLEGAL_CONSTRUCTOR() {
  return withCode(new TypeError('Illegal constructor'), 'ERR_ILLEGAL_CONSTRUCTOR');
}

export function ERR_INVALID_THIS(kind) {
  return withCode(
    new TypeError(`Value of "this" must be of type ${kind}`),
    'ERR_INVALID_THIS',
  );
}

export class AbortError extends Error {
  constructor(message = 'The operation was aborted', options = undefined) {
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      throw ERR_INVALID_ARG_TYPE('options', 'Object', options);
    }
    super(message, options);
    this.code = 'ABORT_ERR';
    this.name = 'AbortError';
  }
}

// ---------------------------------------------------------------------------
// Validators — mirror Node's lib/internal/validators.js
// ---------------------------------------------------------------------------

export function validateFunction(value, name) {
  if (typeof value !== 'function') throw ERR_INVALID_ARG_TYPE(name, 'function', value);
}

export function validateNumber(value, name) {
  if (typeof value !== 'number') throw ERR_INVALID_ARG_TYPE(name, 'number', value);
}

export function validateBoolean(value, name) {
  if (typeof value !== 'boolean') throw ERR_INVALID_ARG_TYPE(name, 'boolean', value);
}

export function validateObject(value, name) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw ERR_INVALID_ARG_TYPE(name, 'Object', value);
  }
}

export function validateAbortSignal(signal, name) {
  if (
    signal !== undefined &&
    (signal === null || typeof signal !== 'object' || !('aborted' in signal))
  ) {
    throw ERR_INVALID_ARG_TYPE(name, 'AbortSignal', signal);
  }
}
