// Minimal port of the pieces of Node's lib/internal/errors.js that the
// node:stream port needs, with byte-exact v24.20.0 message formats.
//
// Each code is a real Error subclass (so `extends ERR_MISSING_ARGS` keeps
// working) with `.code` set and the same `TypeError [ERR_X]`-style name.
// `codes.ERR_X.HideStackFramesError` exists for the validators' destructuring
// (frame hiding itself is a no-op here).

const kTypes = [
  'string',
  'function',
  'number',
  'object',
  // Accept 'Function' and 'Object' as alternative to the lower cased version.
  'Function',
  'Object',
  'boolean',
  'bigint',
  'symbol',
];
const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;

function formatList(array, type = 'and') {
  switch (array.length) {
    case 0: return '';
    case 1: return `${array[0]}`;
    case 2: return `${array[0]} ${type} ${array[1]}`;
    case 3: return `${array[0]}, ${array[1]}, ${type} ${array[2]}`;
    default:
      return `${array.slice(0, -1).join(', ')}, ${type} ${array[array.length - 1]}`;
  }
}

function addNumericalSeparator(val) {
  let res = '';
  let i = val.length;
  const start = val[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) {
    res = `_${val.slice(i - 3, i)}${res}`;
  }
  return `${val.slice(0, i)}${res}`;
}

// Shallow, dependency-free inspect used only for error messages
// (mirrors util.inspect(value, { depth: -1 }) for plain data).
function miniInspect(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  if (type === 'string') return `'${value}'`;
  if (type === 'number' || type === 'boolean' || type === 'bigint') {
    return type === 'bigint' ? `${value}n` : String(value);
  }
  if (type === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (type === 'symbol') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[ ${value.map(miniInspect).join(', ')} ]`;
  }
  if (type === 'object') {
    const proto = Object.getPrototypeOf(value);
    const prefix = proto === null ? '[Object: null prototype] ' : '';
    const keys = Object.keys(value);
    if (keys.length === 0) return `${prefix}{}`;
    return `${prefix}{ ${keys.map((k) => `${k}: ${miniInspect(value[k])}`).join(', ')} }`;
  }
  return String(value);
}

function determineSpecificType(value) {
  if (value === null) {
    return 'null';
  } else if (value === undefined) {
    return 'undefined';
  }

  const type = typeof value;

  switch (type) {
    case 'bigint':
      return `type bigint (${value}n)`;
    case 'number': {
      if (value === 0) {
        return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      } else if (value !== value) { // eslint-disable-line no-self-compare
        return 'type number (NaN)';
      } else if (value === Infinity) {
        return 'type number (Infinity)';
      } else if (value === -Infinity) {
        return 'type number (-Infinity)';
      }
      return `type number (${value})`;
    }
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
      return `${miniInspect(value)}`;
    case 'string': {
      if (value.length > 28) value = `${value.slice(0, 25)}...`;
      if (!value.includes("'")) {
        return `type string ('${value}')`;
      }
      return `type string (${JSON.stringify(value)})`;
    }
  }
  return miniInspect(value);
}

function invalidArgTypeFormatter(name, expected, actual) {
  if (typeof name !== 'string') throw new Error("'name' must be a string");
  if (!Array.isArray(expected)) {
    expected = [expected];
  }

  let msg = 'The ';
  if (name.endsWith(' argument')) {
    // For cases like 'first argument'
    msg += `${name} `;
  } else {
    const type = name.includes('.') ? 'property' : 'argument';
    msg += `"${name}" ${type} `;
  }
  msg += 'must be ';

  const types = [];
  const instances = [];
  const other = [];

  for (const value of expected) {
    if (typeof value !== 'string') throw new Error('All expected entries have to be of type string');
    if (kTypes.includes(value)) {
      types.push(value.toLowerCase());
    } else if (classRegExp.exec(value) !== null) {
      instances.push(value);
    } else {
      if (value === 'object') throw new Error('The value "object" should be written as "Object"');
      other.push(value);
    }
  }

  // Special handle `object` in case other instances are allowed to outline
  // the differences between each other.
  if (instances.length > 0) {
    const pos = types.indexOf('object');
    if (pos !== -1) {
      types.splice(pos, 1);
      instances.push('Object');
    }
  }

  if (types.length > 0) {
    msg += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
    if (instances.length > 0 || other.length > 0)
      msg += ' or ';
  }

  if (instances.length > 0) {
    msg += `an instance of ${formatList(instances, 'or')}`;
    if (other.length > 0)
      msg += ' or ';
  }

  if (other.length > 0) {
    if (other.length > 1) {
      msg += `one of ${formatList(other, 'or')}`;
    } else {
      if (other[0].toLowerCase() !== other[0])
        msg += 'an ';
      msg += `${other[0]}`;
    }
  }

  msg += `. Received ${determineSpecificType(actual)}`;

  return msg;
}

function invalidArgValueFormatter(name, value, reason = 'is invalid') {
  let inspected = miniInspect(value);
  if (inspected.length > 128) {
    inspected = `${inspected.slice(0, 128)}...`;
  }
  const type = name.includes('.') ? 'property' : 'argument';
  return `The ${type} '${name}' ${reason}. Received ${inspected}`;
}

function outOfRangeFormatter(str, range, input, replaceDefaultBoolean = false) {
  if (!range) throw new Error('Missing "range" argument');
  let msg = replaceDefaultBoolean ? str :
    `The value of "${str}" is out of range.`;
  let received;
  if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) {
    received = addNumericalSeparator(String(input));
  } else if (typeof input === 'bigint') {
    received = String(input);
    if (input > 2n ** 32n || input < -(2n ** 32n)) {
      received = addNumericalSeparator(received);
    }
    received += 'n';
  } else {
    received = miniInspect(input);
  }
  msg += ` It must be ${range}. Received ${received}`;
  return msg;
}

function missingArgsFormatter(...args) {
  if (args.length === 0) throw new Error('At least one arg needs to be specified');
  let msg = 'The ';
  const len = args.length;
  const wrap = (a) => `"${a}"`;
  args = args.map(
    (a) => (Array.isArray(a) ?
      a.map(wrap).join(' or ') :
      wrap(a)),
  );
  msg += `${formatList(args)} argument${len > 1 ? 's' : ''}`;
  return `${msg} must be specified`;
}

function invalidReturnValueFormatter(input, name, value) {
  const type = determineSpecificType(value);
  return `Expected ${input} to be returned from the "${name}"` +
         ` function but got ${type}.`;
}

function sprintf(fmt, ...args) {
  let i = 0;
  return fmt.replace(/%s/g, () => {
    const arg = args[i++];
    // Mirror Node's error message formatting: objects are inspected,
    // not String()-ified (e.g. 'Unknown encoding: {}').
    return arg !== null && typeof arg === 'object' ? miniInspect(arg) : String(arg);
  });
}

// E(code, formatter, Base) — mirrors Node's internal E() just enough for
// the stream port: message built by formatter, .code set, TypeError-style
// name, and a HideStackFramesError static for the validators.
function E(code, formatter, Base = Error) {
  class NodeError extends Base {
    constructor(...args) {
      super(typeof formatter === 'function' ? formatter(...args) : sprintf(formatter, ...args));
      this.code = code;
      this.name = Base.name;
    }
    // Mirrors Node's NodeError#toString(): "TypeError [ERR_CODE]: message".
    // The `name` property itself stays the bare base name ('Error', ...).
    toString() {
      return `${this.name} [${this.code}]: ${this.message}`;
    }
  }
  Object.defineProperty(NodeError, 'name', { value: code, configurable: true });
  // Used via `codes.ERR_X: { HideStackFramesError: ERR_X }` destructuring.
  NodeError.HideStackFramesError = NodeError;
  return NodeError;
}

const codes = {
  ERR_INVALID_ARG_TYPE: E('ERR_INVALID_ARG_TYPE', invalidArgTypeFormatter, TypeError),
  ERR_STREAM_PREMATURE_CLOSE: E('ERR_STREAM_PREMATURE_CLOSE', 'Premature close', Error),
  ERR_STREAM_DESTROYED: E('ERR_STREAM_DESTROYED', 'Cannot call %s after a stream was destroyed', Error),
  ERR_UNKNOWN_ENCODING: E('ERR_UNKNOWN_ENCODING', 'Unknown encoding: %s', TypeError),
  ERR_STREAM_NULL_VALUES: E('ERR_STREAM_NULL_VALUES', 'May not write null values to stream', TypeError),
  ERR_INVALID_RETURN_VALUE: E('ERR_INVALID_RETURN_VALUE', invalidReturnValueFormatter, TypeError),
  ERR_MISSING_ARGS: E('ERR_MISSING_ARGS', missingArgsFormatter, TypeError),
  ERR_METHOD_NOT_IMPLEMENTED: E('ERR_METHOD_NOT_IMPLEMENTED', 'The %s method is not implemented', Error),
  ERR_MULTIPLE_CALLBACK: E('ERR_MULTIPLE_CALLBACK', 'Callback called multiple times', Error),
  ERR_INVALID_ARG_VALUE: E('ERR_INVALID_ARG_VALUE', invalidArgValueFormatter, TypeError),
  ERR_OUT_OF_RANGE: E('ERR_OUT_OF_RANGE', outOfRangeFormatter, RangeError),
  ERR_STREAM_PUSH_AFTER_EOF: E('ERR_STREAM_PUSH_AFTER_EOF', 'stream.push() after EOF', Error),
  ERR_ILLEGAL_CONSTRUCTOR: E('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', TypeError),
  ERR_STREAM_WRITE_AFTER_END: E('ERR_STREAM_WRITE_AFTER_END', 'write after end', Error),
  ERR_STREAM_UNSHIFT_AFTER_END_EVENT:
    E('ERR_STREAM_UNSHIFT_AFTER_END_EVENT', 'stream.unshift() after end event'),
  ERR_STREAM_UNABLE_TO_PIPE:
    E('ERR_STREAM_UNABLE_TO_PIPE', 'Cannot pipe to a closed or destroyed stream', Error),
  ERR_STREAM_ITER_MISSING_FLAG:
    E('ERR_STREAM_ITER_MISSING_FLAG', 'The stream/iter API requires the --experimental-stream-iter flag', TypeError),
  ERR_STREAM_CANNOT_PIPE: E('ERR_STREAM_CANNOT_PIPE', 'Cannot pipe, not readable', Error),
  ERR_STREAM_ALREADY_FINISHED:
    E('ERR_STREAM_ALREADY_FINISHED', 'Cannot call %s after a stream was finished', Error),
};

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

const aggregateTwoErrors = (innerError, outerError) => {
  if (innerError && outerError && innerError !== outerError) {
    if (Array.isArray(outerError.errors)) {
      // If `outerError` is already an `AggregateError`.
      outerError.errors.push(innerError);
      return outerError;
    }
    // eslint-disable-next-line no-restricted-syntax
    const err = new AggregateError([outerError, innerError], outerError.message);
    err.code = outerError.code;
    return err;
  }
  return innerError || outerError;
};

export {
  AbortError,
  aggregateTwoErrors,
  codes,
  determineSpecificType,
};
