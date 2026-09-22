// Port of Node.js v24.20.0 `lib/url.js` (legacy `url.parse`/`url.format`/
// `url.resolve` API) as dependency-free ESM.
//
// The WHATWG `URL`, `URLSearchParams` and `URLPattern` exports delegate to
// the host globals where they exist — the same layering modern Node uses
// (native bindings under the hood), so this stays browser-safe.

import { win32 as win32Path, posix as posixPath, sep } from 'node:path';
import { parse as qsParse, stringify as qsStringify } from 'node:querystring';
import { Buffer } from 'buffer';

const kEmptyObject = { __proto__: null };

/* ================================
   WHATWG globals (host-provided)
================================ */

const URLClass = typeof globalThis.URL !== 'undefined' ? globalThis.URL : undefined;
const URLSearchParamsClass =
  typeof globalThis.URLSearchParams !== 'undefined' ? globalThis.URLSearchParams : undefined;
const URLPatternClass =
  typeof globalThis.URLPattern !== 'undefined' ? globalThis.URLPattern : undefined;

const isWindows =
  typeof process !== 'undefined' && process !== null &&
  typeof process.platform === 'string' && process.platform === 'win32';

function emitWarning(message, type, code) {
  if (typeof process !== 'undefined' && process !== null &&
      typeof process.emitWarning === 'function') {
    process.emitWarning(message, type, code);
  }
}

/* ================================
   Error factory (Node error codes)
================================ */

const kTypeNames = [
  'string', 'function', 'number', 'object',
  'Function', 'Object', 'boolean', 'bigint', 'symbol',
];
const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;

function inspectValue(value, truncate = 128) {
  let s;
  const t = typeof value;
  if (t === 'string') {
    s = `'${value}'`;
  } else if (t === 'symbol') {
    s = String(value);
  } else if (t === 'bigint') {
    s = `${value}n`;
  } else {
    try {
      s = JSON.stringify(value) ?? String(value);
    } catch {
      s = String(value);
    }
    if (s === undefined) s = String(value);
  }
  if (s.length > truncate) s = `${s.slice(0, truncate)}...`;
  return s;
}

function determineSpecificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  switch (type) {
    case 'bigint':
      return `type bigint (${value}n)`;
    case 'number': {
      if (value === 0) return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      if (value !== value) return 'type number (NaN)';
      if (value === Infinity) return 'type number (Infinity)';
      if (value === -Infinity) return 'type number (-Infinity)';
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
      return inspectValue(value, 28);
    case 'string': {
      let v = value;
      if (v.length > 28) v = `${v.slice(0, 25)}...`;
      if (!v.includes("'")) return `type string ('${v}')`;
      return `type string (${JSON.stringify(v)})`;
    }
    default:
      return `type ${type} (${inspectValue(value)})`;
  }
}

function formatList(arr, conj) {
  if (arr.length === 1) return arr[0];
  return `${arr.slice(0, -1).join(', ')} ${conj} ${arr[arr.length - 1]}`;
}

function makeError(code, message, Base = TypeError) {
  const err = new Base(message);
  err.code = code;
  return err;
}

function ERR_INVALID_ARG_TYPE(name, expected, actual) {
  if (!Array.isArray(expected)) expected = [expected];
  let msg = 'The ';
  msg += name.endsWith(' argument') ? `${name} ` : `"${name}" argument `;
  msg += 'must be ';

  const types = [];
  const instances = [];
  const other = [];
  for (const value of expected) {
    if (kTypeNames.includes(value)) {
      types.push(value.toLowerCase());
    } else if (classRegExp.test(value)) {
      instances.push(value);
    } else {
      other.push(value);
    }
  }

  // 'object' listed alongside class instances is reported as 'Object'.
  if (instances.length > 0) {
    const pos = types.indexOf('object');
    if (pos !== -1) {
      types.splice(pos, 1);
      instances.push('Object');
    }
  }

  if (types.length > 0) {
    msg += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
    if (instances.length > 0 || other.length > 0) msg += ' or ';
  }
  if (instances.length > 0) {
    msg += `an instance of ${formatList(instances, 'or')}`;
    if (other.length > 0) msg += ' or ';
  }
  if (other.length > 0) {
    if (other.length > 1) {
      msg += `one of ${formatList(other, 'or')}`;
    } else {
      if (other[0].toLowerCase() !== other[0]) msg += 'an ';
      msg += `${other[0]}`;
    }
  }

  msg += `. Received ${determineSpecificType(actual)}`;
  return makeError('ERR_INVALID_ARG_TYPE', msg);
}

function ERR_INVALID_ARG_VALUE(name, value, reason = 'is invalid') {
  return makeError(
    'ERR_INVALID_ARG_VALUE',
    `The argument '${name}' ${reason}. Received ${inspectValue(value)}`,
    RangeError,
  );
}

function ERR_INVALID_FILE_URL_HOST() {
  const platform = typeof process !== 'undefined' && process !== null &&
    typeof process.platform === 'string' ? process.platform : 'browser';
  return makeError(
    'ERR_INVALID_FILE_URL_HOST',
    `File URL host must be "localhost" or empty on ${platform}`,
  );
}

function ERR_INVALID_FILE_URL_PATH(reason, input) {
  const err = makeError('ERR_INVALID_FILE_URL_PATH', `File URL path ${reason}`);
  err.input = input;
  return err;
}

function ERR_INVALID_URL(input) {
  const err = makeError('ERR_INVALID_URL', 'Invalid URL');
  err.input = input;
  return err;
}

function ERR_INVALID_URL_SCHEME(expected) {
  if (typeof expected === 'string') expected = [expected];
  const res = expected.length === 2 ?
    `one of scheme ${expected[0]} or ${expected[1]}` :
    `of scheme ${expected[0]}`;
  return makeError('ERR_INVALID_URL_SCHEME', `The URL must be ${res}`);
}

function ERR_MISSING_ARGS(...args) {
  const wrap = (a) => (Array.isArray(a) ? a.map((x) => `"${x}"`).join(' or ') : `"${a}"`);
  const mapped = args.map(wrap);
  let msg = 'The ';
  if (mapped.length > 1) {
    msg += `${mapped.slice(0, -1).join(', ')} and ${mapped[mapped.length - 1]} arguments `;
  } else {
    msg += `${mapped[0]} argument `;
  }
  msg += 'must be specified';
  return makeError('ERR_MISSING_ARGS', msg);
}

function validateString(value, name) {
  if (typeof value !== 'string') throw ERR_INVALID_ARG_TYPE(name, 'string', value);
}

function validateObject(value, name, options = {}) {
  const allowArray = options.allowArray === true;
  const allowFunction = options.allowFunction === true;
  if (value !== null && typeof value === 'object') {
    if (!Array.isArray(value) || allowArray) return;
  } else if (typeof value === 'function' && allowFunction) {
    return;
  }
  throw ERR_INVALID_ARG_TYPE(name, 'object', value);
}

/* ================================
   Legacy URL parser constants
================================ */

const CHAR_TAB = 9;
const CHAR_LINE_FEED = 10;
const CHAR_CARRIAGE_RETURN = 13;
const CHAR_SPACE = 32;
const CHAR_DOUBLE_QUOTE = 34;
const CHAR_SINGLE_QUOTE = 39;
const CHAR_HASH = 35;
const CHAR_PERCENT = 37;
const CHAR_COLON = 58;
const CHAR_SEMICOLON = 59;
const CHAR_AT = 64;
const CHAR_FORWARD_SLASH = 47;
const CHAR_BACKWARD_SLASH = 92;
const CHAR_QUESTION_MARK = 63;
const CHAR_LEFT_SQUARE_BRACKET = 91;
const CHAR_RIGHT_SQUARE_BRACKET = 93;
const CHAR_LEFT_ANGLE_BRACKET = 60;
const CHAR_RIGHT_ANGLE_BRACKET = 62;
const CHAR_LEFT_CURLY_BRACKET = 123;
const CHAR_RIGHT_CURLY_BRACKET = 125;
const CHAR_CIRCUMFLEX_ACCENT = 94;
const CHAR_GRAVE_ACCENT = 96;
const CHAR_VERTICAL_LINE = 124;
const CHAR_NO_BREAK_SPACE = 160;
const CHAR_ZERO_WIDTH_NOBREAK_SPACE = 65279;

// Protocols that can allow "unsafe" and "unwise" chars.
const unsafeProtocol = new Set(['javascript', 'javascript:']);
// Protocols that never have a hostname.
const hostlessProtocol = new Set(['javascript', 'javascript:']);
// Protocols that always contain a // bit.
const slashedProtocol = new Set([
  'http', 'http:',
  'https', 'https:',
  'ftp', 'ftp:',
  'gopher', 'gopher:',
  'file', 'file:',
  'ws', 'ws:',
  'wss', 'wss:',
]);

// Reference: RFC 3986, RFC 1808, RFC 2396
// Compiled once on first module load.
const protocolPattern = /^[a-z0-9.+-]+:/i;
const portPattern = /:[0-9]*$/;
const hostPattern = /^\/\/[^@/]+@[^@/]+/;
// Special case for a simple path URL
const simplePathPattern = /^(\/\/?(?!\/)[^?\s]*)(\?[^\s]*)?$/;

const hostnameMaxLen = 255;

function isInsideNodeModules() {
  let stack;
  try {
    stack = new Error().stack;
  } catch {
    return false;
  }
  if (!stack) return false;
  return stack.split('\n').some((line) => line.includes('node_modules'));
}

function spliceOne(list, index) {
  for (; index + 1 < list.length; index++) list[index] = list[index + 1];
  list.pop();
}

/* ================================
   Original url.parse() API
================================ */

function Url() {
  this.protocol = null;
  this.slashes = null;
  this.auth = null;
  this.host = null;
  this.port = null;
  this.hostname = null;
  this.hash = null;
  this.search = null;
  this.query = null;
  this.pathname = null;
  this.path = null;
  this.href = null;
}

let urlParseWarned = false;

function urlParse(url, parseQueryString, slashesDenoteHost) {
  if (!urlParseWarned && !isInsideNodeModules()) {
    urlParseWarned = true;
    emitWarning(
      '`url.parse()` behavior is not standardized and prone to ' +
      'errors that have security implications. Use the WHATWG URL API ' +
      'instead. CVEs are not issued for `url.parse()` vulnerabilities.',
      'DeprecationWarning',
      'DEP0169',
    );
  }

  if (url instanceof Url) return url;

  const urlObject = new Url();
  urlObject.parse(url, parseQueryString, slashesDenoteHost);
  return urlObject;
}

function isIpv6Hostname(hostname) {
  return (
    hostname.charCodeAt(0) === CHAR_LEFT_SQUARE_BRACKET &&
    hostname.charCodeAt(hostname.length - 1) === CHAR_RIGHT_SQUARE_BRACKET
  );
}

// IDNA toASCII for the legacy parser. Node uses ada::idna::to_ascii from the
// encoding binding (not the URL binding's domainToASCII): pure-ASCII input is
// simply lowercased with no URL host validation; otherwise full IDNA
// processing applies.
function legacyToASCII(hostname) {
  let asciiOnly = true;
  for (let i = 0; i < hostname.length; i++) {
    if (hostname.charCodeAt(i) > 0x7F) {
      asciiOnly = false;
      break;
    }
  }
  if (asciiOnly) {
    return hostname.toLowerCase();
  }
  if (typeof URLClass === 'undefined') {
    return fallbackPunycode.toASCII(hostname);
  }
  try {
    return new URLClass(`http://${hostname}/`).hostname;
  } catch {
    // The WHATWG host parser additionally rejects IPv4-lookalike domains
    // ("ends in a number"), which IDNA accepts. Appending an inert label
    // distinguishes that case from genuine IDNA failures and forbidden
    // characters, which still throw (legacy parse then throws ERR_INVALID_URL
    // via the forbiddenHostChars check, exactly like Node).
    try {
      const probe = new URLClass(`http://${hostname}.x/`).hostname;
      return probe.endsWith('.x') ? probe.slice(0, -2) : '';
    } catch {
      return '';
    }
  }
}

// Prevents common spoofing bugs from IDNA toASCII. The checked set is the
// intersection of "forbidden host code point" in the WHATWG URL Standard
// and the characters filtered in the host parsing loop, plus ':', '@',
// '[', ']'.
const forbiddenHostChars = /[\0\t\n\r #%/:<>?@[\\\]^|]/;
// For IPv6, permit '[', ']', and ':'.
const forbiddenHostCharsIpv6 = /[\0\t\n\r #%/<>?@\\^|]/;

Url.prototype.parse = function parse(url, parseQueryString, slashesDenoteHost) {
  validateString(url, 'url');

  // Copy chrome, IE, opera backslash-handling behavior.
  // Back slashes before the query string get converted to forward slashes
  // See: https://code.google.com/p/chromium/issues/detail?id=25916
  let hasHash = false;
  let hasAt = false;
  let start = -1;
  let end = -1;
  let rest = '';
  let lastPos = 0;
  for (let i = 0, inWs = false, split = false; i < url.length; ++i) {
    const code = url.charCodeAt(i);

    // Find first and last non-whitespace characters for trimming
    const isWs = code < 33 ||
                 code === CHAR_NO_BREAK_SPACE ||
                 code === CHAR_ZERO_WIDTH_NOBREAK_SPACE;
    if (start === -1) {
      if (isWs)
        continue;
      lastPos = start = i;
    } else if (inWs) {
      if (!isWs) {
        end = -1;
        inWs = false;
      }
    } else if (isWs) {
      end = i;
      inWs = true;
    }

    // Only convert backslashes while we haven't seen a split character
    if (!split) {
      switch (code) {
        case CHAR_AT:
          hasAt = true;
          break;
        case CHAR_HASH:
          hasHash = true;
        // Fall through
        case CHAR_QUESTION_MARK:
          split = true;
          break;
        case CHAR_BACKWARD_SLASH:
          if (i - lastPos > 0)
            rest += url.slice(lastPos, i);
          rest += '/';
          lastPos = i + 1;
          break;
      }
    } else if (!hasHash && code === CHAR_HASH) {
      hasHash = true;
    }
  }

  // Check if string was non-empty (including strings with only whitespace)
  if (start !== -1) {
    if (lastPos === start) {
      // We didn't convert any backslashes
      if (end === -1) {
        if (start === 0)
          rest = url;
        else
          rest = url.slice(start);
      } else {
        rest = url.slice(start, end);
      }
    } else if (end === -1 && lastPos < url.length) {
      // We converted some backslashes and have only part of the entire string
      rest += url.slice(lastPos);
    } else if (end !== -1 && lastPos < end) {
      // We converted some backslashes and have only part of the entire string
      rest += url.slice(lastPos, end);
    }
  }

  if (!slashesDenoteHost && !hasHash && !hasAt) {
    // Try fast path regexp
    const simplePath = simplePathPattern.exec(rest);
    if (simplePath) {
      this.path = rest;
      this.href = rest;
      this.pathname = simplePath[1];
      if (simplePath[2]) {
        this.search = simplePath[2];
        if (parseQueryString) {
          this.query = qsParse(this.search.slice(1));
        } else {
          this.query = this.search.slice(1);
        }
      } else if (parseQueryString) {
        this.search = null;
        this.query = { __proto__: null };
      }
      return this;
    }
  }

  let proto = protocolPattern.exec(rest);
  let lowerProto;
  if (proto) {
    proto = proto[0];
    lowerProto = proto.toLowerCase();
    this.protocol = lowerProto;
    rest = rest.slice(proto.length);
  }

  // Figure out if it's got a host
  // user@server is *always* interpreted as a hostname, and url
  // resolution will treat //foo/bar as host=foo,path=bar because that's
  // how the browser resolves relative URLs.
  let slashes;
  if (slashesDenoteHost || proto || hostPattern.test(rest)) {
    slashes = rest.charCodeAt(0) === CHAR_FORWARD_SLASH &&
              rest.charCodeAt(1) === CHAR_FORWARD_SLASH;
    if (slashes && !(proto && hostlessProtocol.has(lowerProto))) {
      rest = rest.slice(2);
      this.slashes = true;
    }
  }

  if (!hostlessProtocol.has(lowerProto) &&
      (slashes || (proto && !slashedProtocol.has(proto)))) {

    // there's a hostname.
    // the first instance of /, ?, ;, or # ends the host.
    //
    // If there is an @ in the hostname, then non-host chars *are* allowed
    // to the left of the last @ sign, unless some host-ending character
    // comes *before* the @-sign.
    // URLs are obnoxious.
    //
    // ex:
    // http://a@b@c/ => user:a@b host:c
    // http://a@b?@c => user:a host:b path:/?@c

    let hostEnd = -1;
    let atSign = -1;
    let nonHost = -1;
    for (let i = 0; i < rest.length; ++i) {
      switch (rest.charCodeAt(i)) {
        case CHAR_TAB:
        case CHAR_LINE_FEED:
        case CHAR_CARRIAGE_RETURN:
          // WHATWG URL removes tabs, newlines, and carriage returns. Let's do that too.
          rest = rest.slice(0, i) + rest.slice(i + 1);
          i -= 1;
          break;
        case CHAR_SPACE:
        case CHAR_DOUBLE_QUOTE:
        case CHAR_PERCENT:
        case CHAR_SINGLE_QUOTE:
        case CHAR_SEMICOLON:
        case CHAR_LEFT_ANGLE_BRACKET:
        case CHAR_RIGHT_ANGLE_BRACKET:
        case CHAR_BACKWARD_SLASH:
        case CHAR_CIRCUMFLEX_ACCENT:
        case CHAR_GRAVE_ACCENT:
        case CHAR_LEFT_CURLY_BRACKET:
        case CHAR_VERTICAL_LINE:
        case CHAR_RIGHT_CURLY_BRACKET:
          // Characters that are never ever allowed in a hostname from RFC 2396
          if (nonHost === -1)
            nonHost = i;
          break;
        case CHAR_HASH:
        case CHAR_FORWARD_SLASH:
        case CHAR_QUESTION_MARK:
          // Find the first instance of any host-ending characters
          if (nonHost === -1)
            nonHost = i;
          hostEnd = i;
          break;
        case CHAR_AT:
          // At this point, either we have an explicit point where the
          // auth portion cannot go past, or the last @ char is the decider.
          atSign = i;
          nonHost = -1;
          break;
      }
      if (hostEnd !== -1)
        break;
    }
    start = 0;
    if (atSign !== -1) {
      this.auth = decodeURIComponent(rest.slice(0, atSign));
      start = atSign + 1;
    }
    if (nonHost === -1) {
      this.host = rest.slice(start);
      rest = '';
    } else {
      this.host = rest.slice(start, nonHost);
      rest = rest.slice(nonHost);
    }

    // pull out port.
    this.parseHost();

    // We've indicated that there is a hostname,
    // so even if it's empty, it has to be present.
    if (typeof this.hostname !== 'string')
      this.hostname = '';

    const hostname = this.hostname;

    // If hostname begins with [ and ends with ]
    // assume that it's an IPv6 address.
    const ipv6Hostname = isIpv6Hostname(hostname);

    // validate a little.
    if (!ipv6Hostname) {
      rest = getHostname(this, rest, hostname, url);
    }

    if (this.hostname.length > hostnameMaxLen) {
      this.hostname = '';
    } else {
      // Hostnames are always lower case.
      this.hostname = this.hostname.toLowerCase();
    }

    if (this.hostname !== '') {
      if (ipv6Hostname) {
        if (forbiddenHostCharsIpv6.test(this.hostname)) {
          throw ERR_INVALID_URL(url);
        }
      } else {
        // IDNA Support: Returns a punycoded representation of "domain".
        // It only converts parts of the domain name that
        // have non-ASCII characters, i.e. it doesn't matter if
        // you call it with a domain that already is ASCII-only.
        this.hostname = legacyToASCII(this.hostname);

        // Prevent two potential routes of hostname spoofing.
        // 1. If this.hostname is empty, it must have become empty due to toASCII
        //    since we checked this.hostname above.
        // 2. If any of forbiddenHostChars appears in this.hostname, it must have
        //    also gotten in due to toASCII. This is since getHostname would have
        //    filtered them out otherwise.
        // Rather than trying to correct this by moving the non-host part into
        // the pathname as we've done in getHostname, throw an exception to
        // convey the severity of this issue.
        if (this.hostname === '' || forbiddenHostChars.test(this.hostname)) {
          throw ERR_INVALID_URL(url);
        }
      }
    }

    const p = this.port ? ':' + this.port : '';
    const h = this.hostname || '';
    this.host = h + p;

    // strip [ and ] from the hostname
    // the host field still retains them, though
    if (ipv6Hostname) {
      this.hostname = this.hostname.slice(1, -1);
      if (rest[0] !== '/') {
        rest = '/' + rest;
      }
    }
  }

  // Now rest is set to the post-host stuff.
  // Chop off any delim chars.
  if (!unsafeProtocol.has(lowerProto)) {
    // First, make 100% sure that any "autoEscape" chars get
    // escaped, even if encodeURIComponent doesn't think they
    // need to be.
    rest = autoEscapeStr(rest);
  }

  let questionIdx = -1;
  let hashIdx = -1;
  for (let i = 0; i < rest.length; ++i) {
    const code = rest.charCodeAt(i);
    if (code === CHAR_HASH) {
      this.hash = rest.slice(i);
      hashIdx = i;
      break;
    } else if (code === CHAR_QUESTION_MARK && questionIdx === -1) {
      questionIdx = i;
    }
  }

  if (questionIdx !== -1) {
    if (hashIdx === -1) {
      this.search = rest.slice(questionIdx);
      this.query = rest.slice(questionIdx + 1);
    } else {
      this.search = rest.slice(questionIdx, hashIdx);
      this.query = rest.slice(questionIdx + 1, hashIdx);
    }
    if (parseQueryString) {
      this.query = qsParse(this.query);
    }
  } else if (parseQueryString) {
    // No query string, but parseQueryString still requested
    this.search = null;
    this.query = { __proto__: null };
  }

  const useQuestionIdx =
    questionIdx !== -1 && (hashIdx === -1 || questionIdx < hashIdx);
  const firstIdx = useQuestionIdx ? questionIdx : hashIdx;
  if (firstIdx === -1) {
    if (rest.length > 0)
      this.pathname = rest;
  } else if (firstIdx > 0) {
    this.pathname = rest.slice(0, firstIdx);
  }
  if (slashedProtocol.has(lowerProto) &&
      this.hostname && !this.pathname) {
    this.pathname = '/';
  }

  // To support http.request
  if (this.pathname || this.search) {
    const p = this.pathname || '';
    const s = this.search || '';
    this.path = p + s;
  }

  // Finally, reconstruct the href based on what has been validated.
  this.href = this.format();
  return this;
};

let warnInvalidPort = true;
function getHostname(self, rest, hostname, url) {
  for (let i = 0; i < hostname.length; ++i) {
    const code = hostname.charCodeAt(i);
    const isValid = (code !== CHAR_FORWARD_SLASH &&
                     code !== CHAR_BACKWARD_SLASH &&
                     code !== CHAR_HASH &&
                     code !== CHAR_QUESTION_MARK &&
                     code !== CHAR_COLON);

    if (!isValid) {
      // If leftover starts with :, then it represents an invalid port.
      // But url.parse() is lenient about it for now.
      // Issue a warning and continue.
      if (warnInvalidPort && code === CHAR_COLON) {
        const detail = `The URL ${url} is invalid. Future versions of Node.js will throw an error.`;
        emitWarning(detail, 'DeprecationWarning', 'DEP0170');
        warnInvalidPort = false;
      }
      self.hostname = hostname.slice(0, i);
      return `/${hostname.slice(i)}${rest}`;
    }
  }
  return rest;
}

// Escaped characters. Use empty strings to fill up unused entries.
const escapedCodes = [
  /* 0 - 9 */ '', '', '', '', '', '', '', '', '', '%09',
  /* 10 - 19 */ '%0A', '', '', '%0D', '', '', '', '', '', '',
  /* 20 - 29 */ '', '', '', '', '', '', '', '', '', '',
  /* 30 - 39 */ '', '', '%20', '', '%22', '', '', '', '', '%27',
  /* 40 - 49 */ '', '', '', '', '', '', '', '', '', '',
  /* 50 - 59 */ '', '', '', '', '', '', '', '', '', '',
  /* 60 - 69 */ '%3C', '', '%3E', '', '', '', '', '', '', '',
  /* 70 - 79 */ '', '', '', '', '', '', '', '', '', '',
  /* 80 - 89 */ '', '', '', '', '', '', '', '', '', '',
  /* 90 - 99 */ '', '', '%5C', '', '%5E', '', '%60', '', '', '',
  /* 100 - 109 */ '', '', '', '', '', '', '', '', '', '',
  /* 110 - 119 */ '', '', '', '', '', '', '', '', '', '',
  /* 120 - 125 */ '', '', '', '%7B', '%7C', '%7D',
];

// Automatically escape all delimiters and unwise characters from RFC 2396.
// Also escape single quotes in case of an XSS attack.
// Return the escaped string.
function autoEscapeStr(rest) {
  let escaped = '';
  let lastEscapedPos = 0;
  for (let i = 0; i < rest.length; ++i) {
    // `escaped` contains substring up to the last escaped character.
    const escapedChar = escapedCodes[rest.charCodeAt(i)];
    if (escapedChar) {
      // Concat if there are ordinary characters in the middle.
      if (i > lastEscapedPos)
        escaped += rest.slice(lastEscapedPos, i);
      escaped += escapedChar;
      lastEscapedPos = i + 1;
    }
  }
  if (lastEscapedPos === 0)  // Nothing has been escaped.
    return rest;

  // There are ordinary characters at the end.
  if (lastEscapedPos < rest.length)
    escaped += rest.slice(lastEscapedPos);

  return escaped;
}

/* ================================
   url.format()
================================ */

const hexTable = new Array(256);
for (let i = 0; i < 256; ++i) {
  hexTable[i] = '%' + (i < 16 ? '0' : '') + i.toString(16).toUpperCase();
}

// `encodeStr` from internal/querystring, with a caller-supplied no-escape table.
function encodeStr(str, noEscapeTable) {
  const len = str.length;
  if (len === 0)
    return '';

  let out = '';
  let lastPos = 0;
  let i = 0;

  outer:
  for (; i < len; i++) {
    let c = str.charCodeAt(i);

    // ASCII
    while (c < 0x80) {
      if (noEscapeTable[c] !== 1) {
        if (lastPos < i)
          out += str.slice(lastPos, i);
        lastPos = i + 1;
        out += hexTable[c];
      }

      if (++i === len)
        break outer;

      c = str.charCodeAt(i);
    }

    if (lastPos < i)
      out += str.slice(lastPos, i);

    // Multi-byte characters ...
    if (c < 0x800) {
      lastPos = i + 1;
      out += hexTable[0xC0 | (c >> 6)] +
             hexTable[0x80 | (c & 0x3F)];
      continue;
    }
    if (c < 0xD800 || c >= 0xE000) {
      lastPos = i + 1;
      out += hexTable[0xE0 | (c >> 12)] +
             hexTable[0x80 | ((c >> 6) & 0x3F)] +
             hexTable[0x80 | (c & 0x3F)];
      continue;
    }
    // Surrogate pair
    ++i;

    if (i >= len)
      throw makeError('ERR_INVALID_URI', 'URI malformed', URIError);

    const c2 = str.charCodeAt(i) & 0x3FF;
    const cp = 0x10000 + (((c & 0x3FF) << 10) | c2);
    lastPos = i + 1;
    out += hexTable[0xF0 | (cp >> 18)] +
           hexTable[0x80 | ((cp >> 12) & 0x3F)] +
           hexTable[0x80 | ((cp >> 6) & 0x3F)] +
           hexTable[0x80 | (cp & 0x3F)];
  }
  if (lastPos === 0)
    return str;
  if (lastPos < len)
    out += str.slice(lastPos);
  return out;
}

// These characters do not need escaping:
// ! - . _ ~
// ' ( ) * :
// digits
// alpha (uppercase)
// alpha (lowercase)
const noEscapeAuth = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0x00 - 0x0F
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0x10 - 0x1F
  0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, // 0x20 - 0x2F
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, // 0x30 - 0x3F
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 0x40 - 0x4F
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, // 0x50 - 0x5F
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 0x60 - 0x6F
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, // 0x70 - 0x7F
];

Url.prototype.format = function format() {
  let auth = this.auth || '';
  if (auth) {
    auth = encodeStr(auth, noEscapeAuth);
    auth += '@';
  }

  let protocol = this.protocol || '';
  if (protocol && protocol.charCodeAt(protocol.length - 1) !== 58 /* : */) {
    protocol += ':';
  }

  let pathname = this.pathname || '';
  let hash = this.hash || '';
  let host = '';
  let query = '';

  if (this.host) {
    host = auth + this.host;
  } else if (this.hostname) {
    host = auth + (
      this.hostname.indexOf(':') !== -1 && !isIpv6Hostname(this.hostname) ?
        '[' + this.hostname + ']' :
        this.hostname
    );
    if (this.port) {
      host += ':' + this.port;
    }
  }

  if (this.query !== null && typeof this.query === 'object') {
    query = qsStringify(this.query);
  }
  const search = this.search || (query && ('?' + query)) || '';

  let searchOut = search;
  if (pathname.indexOf('#') !== -1 || pathname.indexOf('?') !== -1) {
    let newPathname = '';
    let lastPos = 0;
    const len = pathname.length;
    for (let i = 0; i < len; i++) {
      const code = pathname.charCodeAt(i);
      if (code === CHAR_HASH || code === CHAR_QUESTION_MARK) {
        if (i > lastPos) {
          newPathname += pathname.slice(lastPos, i);
        }
        newPathname += (code === CHAR_HASH ? '%23' : '%3F');
        lastPos = i + 1;
      }
    }
    if (lastPos < len) {
      newPathname += pathname.slice(lastPos);
    }
    pathname = newPathname;
  }

  // Only the slashedProtocols get the //.  Not mailto:, xmpp:, etc.
  // unless they had them to begin with.
  if (this.slashes || slashedProtocol.has(protocol)) {
    if (this.slashes || host) {
      if (pathname && pathname.charCodeAt(0) !== CHAR_FORWARD_SLASH)
        pathname = '/' + pathname;
      host = '//' + host;
    } else if (protocol.length >= 4 &&
               protocol.charCodeAt(0) === 102/* f */ &&
               protocol.charCodeAt(1) === 105/* i */ &&
               protocol.charCodeAt(2) === 108/* l */ &&
               protocol.charCodeAt(3) === 101/* e */) {
      host = '//';
    }
  }

  // Escape '#' in search.
  if (searchOut.indexOf('#') !== -1) {
    searchOut = searchOut.replaceAll('#', '%23');
  }

  if (hash && hash.charCodeAt(0) !== CHAR_HASH) {
    hash = '#' + hash;
  }
  if (searchOut && searchOut.charCodeAt(0) !== CHAR_QUESTION_MARK) {
    searchOut = '?' + searchOut;
  }

  return protocol + host + pathname + searchOut + hash;
};

// Format a parsed object into a url string
function urlFormat(urlObject, options) {
  // Ensure it's an object, and not a string url.
  // If it's an object, this is a no-op.
  // this way, you can call urlParse() on strings
  // to clean up potentially wonky urls.
  if (typeof urlObject === 'string') {
    urlObject = urlParse(urlObject);
  } else if (typeof urlObject !== 'object' || urlObject === null) {
    throw ERR_INVALID_ARG_TYPE('urlObject',
                               ['Object', 'string'], urlObject);
  } else if (typeof URLClass !== 'undefined' && urlObject instanceof URLClass) {
    return formatWhatwgURL(urlObject, options);
  }

  return Url.prototype.format.call(urlObject);
}

// `url.format(whatwgURL[, options])`. Node implements this with the native
// URL binding; here it is done with href string surgery using the parsed
// parts of the WHATWG URL, which the host global provides.
function formatWhatwgURL(urlObject, options) {
  let fragment = true;
  let unicode = false;
  let search = true;
  let auth = true;

  if (options) {
    validateObject(options, 'options');

    if (options.fragment != null) {
      fragment = Boolean(options.fragment);
    }

    if (options.unicode != null) {
      unicode = Boolean(options.unicode);
    }

    if (options.search != null) {
      search = Boolean(options.search);
    }

    if (options.auth != null) {
      auth = Boolean(options.auth);
    }
  }

  const u = urlObject;
  let result = u.href;

  if (!fragment && u.hash !== '') {
    result = result.slice(0, result.length - u.hash.length);
  }

  if (!search && u.search !== '') {
    const idx = result.lastIndexOf(u.search);
    if (idx !== -1) {
      result = result.slice(0, idx) + result.slice(idx + u.search.length);
    }
  }

  if (!auth && (u.username !== '' || u.password !== '')) {
    const userinfo = u.username + (u.password !== '' ? `:${u.password}` : '') + '@';
    const idx = result.indexOf(userinfo);
    if (idx !== -1) {
      result = result.slice(0, idx) + result.slice(idx + userinfo.length);
    }
  }

  if (unicode && u.host !== '' && u.hostname !== '' && u.hostname[0] !== '[') {
    const uni = domainToUnicode(u.hostname);
    if (uni !== u.hostname) {
      const idx = result.indexOf(u.host);
      if (idx !== -1) {
        result = result.slice(0, idx) + uni +
          u.host.slice(u.hostname.length) +
          result.slice(idx + u.host.length);
      }
    }
  }

  return result;
}

/* ================================
   url.resolve() / url.resolveObject()
================================ */

function urlResolve(source, relative) {
  return urlParse(source, false, true).resolve(relative);
}

Url.prototype.resolve = function resolve(relative) {
  return this.resolveObject(urlParse(relative, false, true)).format();
};

function urlResolveObject(source, relative) {
  if (!source) return relative;
  return urlParse(source, false, true).resolveObject(relative);
}

Url.prototype.resolveObject = function resolveObject(relative) {
  if (typeof relative === 'string') {
    const rel = new Url();
    rel.parse(relative, false, true);
    relative = rel;
  }

  const result = new Url();
  Object.assign(result, this);

  // Hash is always overridden, no matter what.
  // even href="" will remove it.
  result.hash = relative.hash;

  // If the relative url is empty, then there's nothing left to do here.
  if (relative.href === '') {
    result.href = result.format();
    return result;
  }

  // Hrefs like //foo/bar always cut to the protocol.
  if (relative.slashes && !relative.protocol) {
    // Take everything except the protocol from relative
    const relativeWithoutProtocol = Object.keys(relative).reduce((acc, key) => {
      if (key !== 'protocol') {
        acc[key] = relative[key];
      }
      return acc;
    }, {});
    Object.assign(result, relativeWithoutProtocol);

    // urlParse appends trailing / to urls like http://www.example.com
    if (slashedProtocol.has(result.protocol) &&
        result.hostname && !result.pathname) {
      result.path = result.pathname = '/';
    }

    result.href = result.format();
    return result;
  }

  if (relative.protocol && relative.protocol !== result.protocol) {
    // If it's a known url protocol, then changing
    // the protocol does weird things
    // first, if it's not file:, then we MUST have a host,
    // and if there was a path
    // to begin with, then we MUST have a path.
    // if it is file:, then the host is dropped,
    // because that's known to be hostless.
    // anything else is assumed to be absolute.
    if (!slashedProtocol.has(relative.protocol)) {
      Object.assign(result, relative);
      result.href = result.format();
      return result;
    }

    result.protocol = relative.protocol;
    if (!relative.host &&
        !/^file:?$/.test(relative.protocol) &&
        !hostlessProtocol.has(relative.protocol)) {
      const relPath = (relative.pathname || '').split('/');
      while (relPath.length && !(relative.host = relPath.shift()));
      relative.host ||= '';
      relative.hostname ||= '';
      if (relPath[0] !== '') relPath.unshift('');
      if (relPath.length < 2) relPath.unshift('');
      result.pathname = relPath.join('/');
    } else {
      result.pathname = relative.pathname;
    }
    result.search = relative.search;
    result.query = relative.query;
    result.host = relative.host || '';
    result.auth = relative.auth;
    result.hostname = relative.hostname || relative.host;
    result.port = relative.port;
    // To support http.request
    if (result.pathname || result.search) {
      const p = result.pathname || '';
      const s = result.search || '';
      result.path = p + s;
    }
    result.slashes ||= relative.slashes;
    result.href = result.format();
    return result;
  }

  const isSourceAbs = (result.pathname && result.pathname.charAt(0) === '/');
  const isRelAbs = (
    relative.host || (relative.pathname && relative.pathname.charAt(0) === '/')
  );
  let mustEndAbs = (isRelAbs || isSourceAbs ||
                    (result.host && relative.pathname));
  const removeAllDots = mustEndAbs;
  let srcPath = (result.pathname && result.pathname.split('/')) || [];
  const relPath = (relative.pathname && relative.pathname.split('/')) || [];
  const noLeadingSlashes = result.protocol &&
      !slashedProtocol.has(result.protocol);

  // If the url is a non-slashed url, then relative
  // links like ../.. should be able
  // to crawl up to the hostname, as well.  This is strange.
  // result.protocol has already been set by now.
  // Later on, put the first path part into the host field.
  if (noLeadingSlashes) {
    result.hostname = '';
    result.port = null;
    if (result.host) {
      if (srcPath[0] === '') srcPath[0] = result.host;
      else srcPath.unshift(result.host);
    }
    result.host = '';
    if (relative.protocol) {
      relative.hostname = null;
      relative.port = null;
      result.auth = null;
      if (relative.host) {
        if (relPath[0] === '') relPath[0] = relative.host;
        else relPath.unshift(relative.host);
      }
      relative.host = null;
    }
    mustEndAbs &&= (relPath[0] === '' || srcPath[0] === '');
  }

  if (isRelAbs) {
    // it's absolute.
    if (relative.host || relative.host === '') {
      if (result.host !== relative.host) result.auth = null;
      result.host = relative.host;
      result.port = relative.port;
    }
    if (relative.hostname || relative.hostname === '') {
      if (result.hostname !== relative.hostname) result.auth = null;
      result.hostname = relative.hostname;
    }
    result.search = relative.search;
    result.query = relative.query;
    srcPath = relPath;
    // Fall through to the dot-handling below.
  } else if (relPath.length) {
    // it's relative
    // throw away the existing file, and take the new path instead.
    srcPath ||= [];
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    result.search = relative.search;
    result.query = relative.query;
  } else if (relative.search !== null && relative.search !== undefined) {
    // Just pull out the search.
    // like href='?foo'.
    // Put this after the other two cases because it simplifies the booleans
    if (noLeadingSlashes) {
      result.hostname = result.host = srcPath.shift();
      // Occasionally the auth can get stuck only in host.
      // This especially happens in cases like
      // url.resolveObject('mailto:local1@domain1', 'local2@domain2')
      const authInHost =
        result.host && result.host.indexOf('@') > 0 && result.host.split('@');
      if (authInHost) {
        result.auth = authInHost.shift();
        result.host = result.hostname = authInHost.shift();
      }
    }
    result.search = relative.search;
    result.query = relative.query;
    // To support http.request
    if (result.pathname !== null || result.search !== null) {
      result.path = (result.pathname ? result.pathname : '') +
                    (result.search ? result.search : '');
    }
    result.href = result.format();
    return result;
  }

  if (!srcPath.length) {
    // No path at all. All other things were already handled above.
    result.pathname = null;
    // To support http.request
    if (result.search) {
      result.path = '/' + result.search;
    } else {
      result.path = null;
    }
    result.href = result.format();
    return result;
  }

  // If a url ENDs in . or .., then it must get a trailing slash.
  // however, if it ends in anything else non-slashy,
  // then it must NOT get a trailing slash.
  let last = srcPath[srcPath.length - 1];
  const hasTrailingSlash = (
    ((result.host || relative.host || srcPath.length > 1) &&
    (last === '.' || last === '..')) || last === '');

  // Strip single dots, resolve double dots to parent dir
  // if the path tries to go above the root, `up` ends up > 0
  let up = 0;
  for (let i = srcPath.length - 1; i >= 0; i--) {
    last = srcPath[i];
    if (last === '.') {
      spliceOne(srcPath, i);
    } else if (last === '..') {
      spliceOne(srcPath, i);
      up++;
    } else if (up) {
      spliceOne(srcPath, i);
      up--;
    }
  }

  // If the path is allowed to go above the root, restore leading ..s
  if (!mustEndAbs && !removeAllDots) {
    while (up--) {
      srcPath.unshift('..');
    }
  }

  if (mustEndAbs && srcPath[0] !== '' &&
      (!srcPath[0] || srcPath[0].charAt(0) !== '/')) {
    srcPath.unshift('');
  }

  if (hasTrailingSlash && srcPath.join('/').at(-1) !== '/') {
    srcPath.push('');
  }

  const isAbsolute = srcPath[0] === '' ||
      (srcPath[0] && srcPath[0].charAt(0) === '/');

  // put the host back
  if (noLeadingSlashes) {
    result.hostname =
      result.host = isAbsolute ? '' : srcPath.length ? srcPath.shift() : '';
    // Occasionally the auth can get stuck only in host.
    // This especially happens in cases like
    // url.resolveObject('mailto:local1@domain1', 'local2@domain2')
    const authInHost = result.host && result.host.indexOf('@') > 0 ?
      result.host.split('@') : false;
    if (authInHost) {
      result.auth = authInHost.shift();
      result.host = result.hostname = authInHost.shift();
    }
  }

  mustEndAbs ||= (result.host && srcPath.length);

  if (mustEndAbs && !isAbsolute) {
    srcPath.unshift('');
  }

  if (!srcPath.length) {
    result.pathname = null;
    result.path = null;
  } else {
    result.pathname = srcPath.join('/');
  }

  // To support request.http
  if (result.pathname !== null || result.search !== null) {
    result.path = (result.pathname ? result.pathname : '') +
                  (result.search ? result.search : '');
  }
  result.auth = relative.auth || result.auth;
  result.slashes ||= relative.slashes;
  result.href = result.format();
  return result;
};

Url.prototype.parseHost = function parseHost() {
  let host = this.host;
  const port = portPattern.exec(host);
  if (port) {
    const portStr = port[0];
    if (portStr !== ':') {
      this.port = portStr.slice(1);
    }
    host = host.slice(0, host.length - portStr.length);
  }
  if (host) this.hostname = host;
};

/* ================================
   Domain helpers
================================ */

// Node implements these with the native URL binding (ada::parse of `ws://x`
// followed by set_hostname, which silently leaves the host unchanged when
// the domain is invalid). The dual-sentinel probe below reproduces that
/* ================================
   Vendored punycode fallback (warning-free)
================================ */
// The bootstring algorithm below is copied verbatim from `./punycode.js`
// (itself a port of Node v24.20.0 `lib/punycode.js`) so the no-`URL`
// fallback paths stay dependency-free and never emit DEP0040: importing
// `./punycode.js` would emit the deprecation warning at load time, which
// Node suppresses for builtin importers via isInsideNodeModules() —
// `require('url')` must not warn. Only used when `globalThis.URL` is
// undefined; every real Node.js runtime and browser provides it.
const fallbackPunycode = (() => {
/** Highest positive signed 32-bit float value */
const maxInt = 2147483647; // aka. 0x7FFFFFFF or 2^31-1

/** Bootstring parameters */
const base = 36;
const tMin = 1;
const tMax = 26;
const skew = 38;
const damp = 700;
const initialBias = 72;
const initialN = 128; // 0x80
const delimiter = '-'; // '\x2D'

/** Regular expressions */
const regexPunycode = /^xn--/;
const regexNonASCII = /[^\0-\x7F]/; // Note: U+007F DEL is excluded too.
const regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g; // RFC 3490 separators

/** Error messages */
const errors = {
	'overflow': 'Overflow: input needs wider integers to process',
	'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
	'invalid-input': 'Invalid input'
};

/** Convenience shortcuts */
const baseMinusTMin = base - tMin;
const floor = Math.floor;
const stringFromCharCode = String.fromCharCode;
function error(type) {
	throw new RangeError(errors[type]);
}
function map(array, callback) {
	const result = [];
	let length = array.length;
	while (length--) {
		result[length] = callback(array[length]);
	}
	return result;
}
function mapDomain(domain, callback) {
	const parts = domain.split('@');
	let result = '';
	if (parts.length > 1) {
		// In email addresses, only the domain name should be punycoded. Leave
		// the local part (i.e. everything up to `@`) intact.
		result = parts[0] + '@';
		domain = parts[1];
	}
	// Avoid `split(regex)` for IE8 compatibility. See #17.
	domain = domain.replace(regexSeparators, '\x2E');
	const labels = domain.split('.');
	const encoded = map(labels, callback).join('.');
	return result + encoded;
}
function ucs2decode(string) {
	const output = [];
	let counter = 0;
	const length = string.length;
	while (counter < length) {
		const value = string.charCodeAt(counter++);
		if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
			// It's a high surrogate, and there is a next character.
			const extra = string.charCodeAt(counter++);
			if ((extra & 0xFC00) == 0xDC00) { // Low surrogate.
				output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
			} else {
				// It's an unmatched surrogate; only append this code unit, in case the
				// next code unit is the high surrogate of a surrogate pair.
				output.push(value);
				counter--;
			}
		} else {
			output.push(value);
		}
	}
	return output;
}
const ucs2encode = codePoints => String.fromCodePoint(...codePoints);
const basicToDigit = function(codePoint) {
	if (codePoint >= 0x30 && codePoint < 0x3A) {
		return 26 + (codePoint - 0x30);
	}
	if (codePoint >= 0x41 && codePoint < 0x5B) {
		return codePoint - 0x41;
	}
	if (codePoint >= 0x61 && codePoint < 0x7B) {
		return codePoint - 0x61;
	}
	return base;
};
const digitToBasic = function(digit, flag) {
	//  0..25 map to ASCII a..z or A..Z
	// 26..35 map to ASCII 0..9
	return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
};
const adapt = function(delta, numPoints, firstTime) {
	let k = 0;
	delta = firstTime ? floor(delta / damp) : delta >> 1;
	delta += floor(delta / numPoints);
	for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
		delta = floor(delta / baseMinusTMin);
	}
	return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
};
const decode = function(input) {
	// Don't use UCS-2.
	const output = [];
	const inputLength = input.length;
	let i = 0;
	let n = initialN;
	let bias = initialBias;

	// Handle the basic code points: let `basic` be the number of input code
	// points before the last delimiter, or `0` if there is none, then copy
	// the first basic code points to the output.

	let basic = input.lastIndexOf(delimiter);
	if (basic < 0) {
		basic = 0;
	}

	for (let j = 0; j < basic; ++j) {
		// if it's not a basic code point
		if (input.charCodeAt(j) >= 0x80) {
			error('not-basic');
		}
		output.push(input.charCodeAt(j));
	}

	// Main decoding loop: start just after the last delimiter if any basic code
	// points were copied; start at the beginning otherwise.

	for (let index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

		// `index` is the index of the next character to be consumed.
		// Decode a generalized variable-length integer into `delta`,
		// which gets added to `i`. The overflow checking is easier
		// if we increase `i` as we go, then subtract off its starting
		// value at the end to obtain `delta`.
		const oldi = i;
		for (let w = 1, k = base; /* no condition */; k += base) {

			if (index >= inputLength) {
				error('invalid-input');
			}

			const digit = basicToDigit(input.charCodeAt(index++));

			if (digit >= base) {
				error('invalid-input');
			}
			if (digit > floor((maxInt - i) / w)) {
				error('overflow');
			}

			i += digit * w;
			const t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

			if (digit < t) {
				break;
			}

			const baseMinusT = base - t;
			if (w > floor(maxInt / baseMinusT)) {
				error('overflow');
			}

			w *= baseMinusT;

		}

		const out = output.length + 1;
		bias = adapt(i - oldi, out, oldi == 0);

		// `i` was supposed to wrap around from `out` to `0`,
		// incrementing `n` each time, so we'll fix that now:
		if (floor(i / out) > maxInt - n) {
			error('overflow');
		}

		n += floor(i / out);
		i %= out;

		// Insert `n` at position `i` of the output.
		output.splice(i++, 0, n);

	}

	return String.fromCodePoint(...output);
};
const encode = function(input) {
	const output = [];

	// Convert the input in UCS-2 to an array of Unicode code points.
	input = ucs2decode(input);

	// Cache the length.
	const inputLength = input.length;

	// Initialize the state.
	let n = initialN;
	let delta = 0;
	let bias = initialBias;

	// Handle the basic code points.
	for (const currentValue of input) {
		if (currentValue < 0x80) {
			output.push(stringFromCharCode(currentValue));
		}
	}

	const basicLength = output.length;
	let handledCPCount = basicLength;

	// `handledCPCount` is the number of code points that have been handled;
	// `basicLength` is the number of basic code points.

	// Finish the basic string with a delimiter unless it's empty.
	if (basicLength) {
		output.push(delimiter);
	}

	// Main encoding loop:
	while (handledCPCount < inputLength) {

		// All non-basic code points < n have been handled already. Find the next
		// larger one:
		let m = maxInt;
		for (const currentValue of input) {
			if (currentValue >= n && currentValue < m) {
				m = currentValue;
			}
		}

		// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
		// but guard against overflow.
		const handledCPCountPlusOne = handledCPCount + 1;
		if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
			error('overflow');
		}

		delta += (m - n) * handledCPCountPlusOne;
		n = m;

		for (const currentValue of input) {
			if (currentValue < n && ++delta > maxInt) {
				error('overflow');
			}
			if (currentValue === n) {
				// Represent delta as a generalized variable-length integer.
				let q = delta;
				for (let k = base; /* no condition */; k += base) {
					const t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
					if (q < t) {
						break;
					}
					const qMinusT = q - t;
					const baseMinusT = base - t;
					output.push(
						stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
					);
					q = floor(qMinusT / baseMinusT);
				}

				output.push(stringFromCharCode(digitToBasic(q, 0)));
				bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
				delta = 0;
				++handledCPCount;
			}
		}

		++delta;
		++n;

	}
	return output.join('');
};
const toUnicode = function(input) {
	return mapDomain(input, function(string) {
		return regexPunycode.test(string)
			? decode(string.slice(4).toLowerCase())
			: string;
	});
};
const toASCII = function(input) {
	return mapDomain(input, function(string) {
		return regexNonASCII.test(string)
			? 'xn--' + encode(string)
			: string;
	});
};
  return { toASCII, toUnicode };
})();

// "unchanged on failure" detection exactly with the host WHATWG URL.
function idnaToASCII(domain) {
  const probe1 = new URLClass('ws://a');
  probe1.hostname = domain;
  if (probe1.hostname !== 'a') return probe1.hostname;
  const probe2 = new URLClass('ws://b');
  probe2.hostname = domain;
  return probe2.hostname !== 'b' ? probe2.hostname : '';
}

function domainToASCII(domain) {
  if (arguments.length < 1)
    throw ERR_MISSING_ARGS('domain');
  domain = `${domain}`;
  if (domain === '') return '';
  if (typeof URLClass === 'undefined') {
    return fallbackPunycode.toASCII(domain);
  }
  return idnaToASCII(domain);
}

function domainToUnicode(domain) {
  if (arguments.length < 1)
    throw ERR_MISSING_ARGS('domain');
  domain = `${domain}`;
  if (domain === '') return '';
  if (typeof URLClass === 'undefined') {
    return fallbackPunycode.toUnicode(domain);
  }
  const ascii = idnaToASCII(domain);
  if (ascii === '') return '';
  return fallbackPunycode.toUnicode(ascii);
}

/* ================================
   File URL <-> path conversion
================================ */

// WHATWG URL parsers used by Node (ada) encode lone UTF-16 surrogates in
// file paths as WTF-8 (each surrogate becomes a 3-byte ED A0 80..ED BF BF
// sequence), because the native binding receives the path as a UTF-8 byte
// string from V8. TextEncoder would substitute U+FFFD instead, so encode
// manually to stay byte-identical.
function utf8Wtf8Bytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
    } else if (c < 0xD800 || c >= 0xE000) {
      bytes.push(
        0xE0 | (c >> 12),
        0x80 | ((c >> 6) & 0x3F),
        0x80 | (c & 0x3F),
      );
    } else {
      // Surrogate: consume a pair, otherwise WTF-8-encode the lone surrogate.
      const c2 = str.charCodeAt(i + 1);
      if (c < 0xDC00 && c2 >= 0xDC00 && c2 < 0xE000) {
        const cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        bytes.push(
          0xF0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3F),
          0x80 | ((cp >> 6) & 0x3F),
          0x80 | (cp & 0x3F),
        );
        i++;
      } else {
        bytes.push(
          0xE0 | (c >> 12),
          0x80 | ((c >> 6) & 0x3F),
          0x80 | (c & 0x3F),
        );
      }
    }
  }
  return bytes;
}

// Lookup table from Node's src/node_url.cc EncodePathChars (RFC 1738
// "unsafe" characters). Maps an ASCII byte to its %-encoded form, or
// undefined when the byte passes through unchanged.
const pathCharLookupTable = (() => {
  const table = new Array(0x7F);
  const encode = (code, hex) => { table[code] = `%${hex}`; };
  encode(0x00, '00');
  encode(0x09, '09');
  encode(0x0A, '0A');
  encode(0x0D, '0D');
  encode(0x20, '20');
  encode(0x22, '22');
  encode(0x23, '23');
  encode(0x25, '25');
  encode(0x3F, '3F');
  encode(0x5B, '5B');
  encode(0x5C, '5C');
  encode(0x5D, '5D');
  encode(0x5E, '5E');
  encode(0x7C, '7C');
  encode(0x7E, '7E');
  return table;
})();

// Equivalent of Node's EncodePathChars: builds the `file://` + transformed
// path string that is then parsed as a URL. Non-ASCII bytes are %-encoded
// (the WHATWG URL parser would do exactly that for them in a path).
function encodePathChars(input, windows) {
  const bytes = utf8Wtf8Bytes(input);
  let encoded = 'file://';
  for (const byte of bytes) {
    if (byte > 0x7E) {
      encoded += hexTable[byte];
      continue;
    }
    if (windows && byte === 0x5C /* \ */) {
      encoded += '/';
      continue;
    }
    const mapped = pathCharLookupTable[byte];
    encoded += mapped !== undefined ? mapped : String.fromCharCode(byte);
  }
  return encoded;
}

// Equivalent of ada's set_host_or_hostname for file URLs (used for UNC
// hostnames): truncate at the first '#', drop ASCII tab/newline, truncate
// at the first of `/\?`, clear `localhost`, then host-parse. Throws
// ERR_INVALID_URL when host parsing fails.
function setFileURLHostname(urlObject, hostname, inputForError) {
  let host = hostname;
  const hashIndex = host.indexOf('#');
  if (hashIndex !== -1) host = host.slice(0, hashIndex);
  host = host.replace(/[\t\n\r]/g, '');
  const terminator = host.search(/[/\\?]/);
  if (terminator !== -1) host = host.slice(0, terminator);
  if (host.toLowerCase() === 'localhost') host = '';
  if (host === '') {
    urlObject.hostname = '';
    return;
  }
  const probe = new URLClass('file:///');
  probe.hostname = host;
  if (probe.hostname === '') {
    throw ERR_INVALID_URL(inputForError);
  }
  urlObject.hostname = probe.hostname;
}

function isURL(self) {
  return Boolean(
    self?.href && self.protocol &&
    self.auth === undefined && self.path === undefined,
  );
}

const platform = typeof process !== 'undefined' && process !== null &&
  typeof process.platform === 'string' ? process.platform : 'browser';

function getPathFromURLWin32(url) {
  const hostname = url.hostname;
  let pathname = url.pathname;
  for (let n = 0; n < pathname.length; n++) {
    if (pathname[n] === '%') {
      const third = pathname.codePointAt(n + 2) | 0x20;
      if ((pathname[n + 1] === '2' && third === 102) || // 2f 2F /
          (pathname[n + 1] === '5' && third === 99)) {  // 5c 5C \
        throw ERR_INVALID_FILE_URL_PATH(
          'must not include encoded \\ or / characters', url);
      }
    }
  }
  pathname = pathname.replaceAll('/', '\\');
  // Fast-path: if there is no percent-encoding, avoid decodeURIComponent.
  if (pathname.includes('%')) {
    pathname = decodeURIComponent(pathname);
  }
  if (hostname !== '') {
    // If hostname is set, then we have a UNC path
    // Pass the hostname through domainToUnicode just in case
    // it is an IDN using punycode encoding. We do not need to worry
    // about percent encoding because the URL parser will have
    // already taken care of that for us. Note that this only
    // causes IDNs with an appropriate `xn--` prefix to be decoded.
    return `\\\\${domainToUnicode(hostname)}${pathname}`;
  }
  // Otherwise, it's a local path that requires a drive letter
  const letter = pathname.codePointAt(1) | 0x20;
  const sep = pathname.charAt(2);
  if (letter < 97 /* a */ || letter > 122 /* z */ ||
      (sep !== ':')) {
    throw ERR_INVALID_FILE_URL_PATH('must be absolute', url);
  }
  return pathname.slice(1);
}

function getPathFromURLPosix(url) {
  if (url.hostname !== '') {
    throw ERR_INVALID_FILE_URL_HOST(platform);
  }
  const pathname = url.pathname;
  for (let n = 0; n < pathname.length; n++) {
    if (pathname[n] === '%') {
      const third = pathname.codePointAt(n + 2) | 0x20;
      if (pathname[n + 1] === '2' && third === 102) {
        throw ERR_INVALID_FILE_URL_PATH(
          'must not include encoded / characters',
          url,
        );
      }
    }
  }
  // Fast-path: if there is no percent-encoding, avoid decodeURIComponent.
  return pathname.includes('%') ? decodeURIComponent(pathname) : pathname;
}

// https://infra.spec.whatwg.org/#percent-decode — byte-literal decoding
// where invalid %-sequences pass through unchanged.
function percentDecode(input) {
  const length = input.length;
  const output = new Uint8Array(length);
  let j = 0;
  const isHex = (b) =>
    (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
  const hexVal = (b) =>
    b <= 0x39 ? b - 0x30 : (b <= 0x46 ? b - 0x41 + 10 : b - 0x61 + 10);
  for (let i = 0; i < length; ++i) {
    const byte = input[i];
    if (byte !== 0x25) {
      output[j++] = byte;
    } else if (!(isHex(input[i + 1]) && isHex(input[i + 2]))) {
      output[j++] = 0x25;
    } else {
      output[j++] = (hexVal(input[i + 1]) << 4) | hexVal(input[i + 2]);
      i += 2;
    }
  }
  return length === j ? output : output.subarray(0, j);
}

function getPathBufferFromURLWin32(url) {
  const hostname = url.hostname;
  let pathname = url.pathname;
  // In the getPathFromURLWin32 variant, we scan the input for backslash (\)
  // and forward slash (/) characters... for this variation where we are
  // producing a buffer, we won't scan for the slashes at all, and instead
  // will decode the bytes literally into the returned Buffer.
  pathname = pathname.replaceAll('/', '\\');
  const decodedu8 = percentDecode(Buffer.from(pathname, 'utf8'));
  const decodedPathname = Buffer.from(
    decodedu8.buffer, decodedu8.byteOffset, decodedu8.byteLength);
  if (hostname !== '') {
    // If hostname is set, then we have a UNC path
    // Pass the hostname through domainToUnicode just in case
    // it is an IDN using punycode encoding.
    const prefix = Buffer.from('\\\\', 'ascii');
    const domain = Buffer.from(domainToUnicode(hostname), 'utf8');
    return Buffer.concat([prefix, domain, decodedPathname]);
  }
  // Otherwise, it's a local path that requires a drive letter
  // In this case we're only going to pay attention to the second and
  // third bytes in the decodedPathname. If first byte is either an ASCII
  // uppercase letter between 'A' and 'Z' or lowercase letter between
  // 'a' and 'z', and the second byte must be an ASCII `:` or the
  // operation will fail.
  const letter = decodedPathname[1] | 0x20;
  const sep = decodedPathname[2];
  if (letter < 97 /* a */ || letter > 122 /* z */ ||
      (sep !== 58 /* : */)) {
    throw ERR_INVALID_FILE_URL_PATH('must be absolute', url);
  }
  // Now, we'll just return everything except the first byte of
  // the decoded pathname.
  return Buffer.from(
    decodedPathname.buffer,
    decodedPathname.byteOffset + 1,
    decodedPathname.byteLength - 1,
  );
}

function getPathBufferFromURLPosix(url) {
  if (url.hostname !== '') {
    throw ERR_INVALID_FILE_URL_HOST(platform);
  }
  const pathname = url.pathname;
  // In the getPathFromURLPosix variant, we scan the input for forward slash
  // (/) characters... for this variation where we are producing a buffer,
  // we won't scan for the slashes at all, and instead will decode the bytes
  // literally into the returned Buffer.
  const u8 = percentDecode(Buffer.from(pathname, 'utf8'));
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

function fileURLToPath(path, options = kEmptyObject) {
  const windows = options?.windows;
  if (typeof path === 'string')
    path = new URLClass(path);
  else if (!isURL(path))
    throw ERR_INVALID_ARG_TYPE('path', ['string', 'URL'], path);
  if (path.protocol !== 'file:')
    throw ERR_INVALID_URL_SCHEME('file');
  return (windows ?? isWindows) ? getPathFromURLWin32(path) : getPathFromURLPosix(path);
}

function fileURLToPathBuffer(path, options = kEmptyObject) {
  const windows = options?.windows;
  if (typeof path === 'string') {
    path = new URLClass(path);
  } else if (!isURL(path)) {
    throw ERR_INVALID_ARG_TYPE('path', ['string', 'URL'], path);
  }
  if (path.protocol !== 'file:') {
    throw ERR_INVALID_URL_SCHEME('file');
  }
  return (windows ?? isWindows) ?
    getPathBufferFromURLWin32(path) : getPathBufferFromURLPosix(path);
}

function _pathToFileURL(filepath, options) {
  const windows = options?.windows ?? isWindows;
  const isUNC = windows && filepath.startsWith('\\\\');
  let resolved = isUNC ?
    filepath :
    (windows ? win32Path.resolve(filepath) : posixPath.resolve(filepath));
  if (isUNC || (windows && resolved.startsWith('\\\\'))) {
    // UNC path format: \\server\share\resource
    // Handle extended UNC path and standard UNC path
    // "\\?\UNC\" path prefix should be ignored.
    const isExtendedUNC = resolved.startsWith('\\\\?\\UNC\\');
    const prefixLength = isExtendedUNC ? 8 : 2;
    const hostnameEndIndex = resolved.indexOf('\\', prefixLength);
    if (hostnameEndIndex === -1) {
      throw ERR_INVALID_ARG_VALUE(
        'path',
        resolved,
        'Missing UNC resource path',
      );
    }
    if (hostnameEndIndex === 2) {
      throw ERR_INVALID_ARG_VALUE(
        'path',
        resolved,
        'Empty UNC servername',
      );
    }
    const hostname = resolved.slice(prefixLength, hostnameEndIndex);
    const rest = resolved.slice(hostnameEndIndex);
    let outURL;
    try {
      outURL = new URLClass(encodePathChars(rest, true));
    } catch {
      throw ERR_INVALID_URL(filepath);
    }
    setFileURLHostname(outURL, hostname, filepath);
    return outURL;
  }
  // path.resolve strips trailing slashes so we must add them back
  const filePathLast = filepath.charCodeAt(filepath.length - 1);
  if ((filePathLast === CHAR_FORWARD_SLASH ||
       (windows && filePathLast === CHAR_BACKWARD_SLASH)) &&
      resolved[resolved.length - 1] !== sep)
    resolved += '/';

  try {
    return new URLClass(encodePathChars(resolved, windows));
  } catch {
    throw ERR_INVALID_URL(filepath);
  }
}

function pathToFileURL(path, options) {
  validateString(path, 'path');
  return _pathToFileURL(path, options);
}

/* ================================
   urlToHttpOptions
================================ */

/**
 * Utility function that converts a URL object into an ordinary options object
 * as expected by the `http.request` and `https.request` APIs.
 */
function urlToHttpOptions(url) {
  validateObject(url, 'url', { allowArray: true, allowFunction: true });
  const { hostname, pathname, port, username, password, search } = url;
  const options = {
    __proto__: null,
    ...url, // In case the url object was extended by the user.
    protocol: url.protocol,
    hostname: hostname && hostname[0] === '[' ?
      hostname.slice(1, -1) :
      hostname,
    hash: url.hash,
    search: search,
    pathname: pathname,
    path: `${pathname || ''}${search || ''}`,
    href: url.href,
  };
  if (port !== '') {
    options.port = Number(port);
  }
  if (username || password) {
    options.auth = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
  }
  return options;
}

/* ================================
   Exports (Node v24.20.0 surface)
================================ */

export {
  URLClass as URL,
  URLPatternClass as URLPattern,
  URLSearchParamsClass as URLSearchParams,
  Url,
  domainToASCII,
  domainToUnicode,
  fileURLToPath,
  fileURLToPathBuffer,
  urlFormat as format,
  urlParse as parse,
  pathToFileURL,
  urlResolve as resolve,
  urlResolveObject as resolveObject,
  urlToHttpOptions,
};

export default {
  URL: URLClass,
  URLPattern: URLPatternClass,
  URLSearchParams: URLSearchParamsClass,
  Url,
  domainToASCII,
  domainToUnicode,
  fileURLToPath,
  fileURLToPathBuffer,
  format: urlFormat,
  parse: urlParse,
  pathToFileURL,
  resolve: urlResolve,
  resolveObject: urlResolveObject,
  urlToHttpOptions,
};
