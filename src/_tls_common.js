// node:_tls_common — Node internal TLS helpers.
//
// The browser has no raw-TLS API, so SecureContext is an opaque handle
// (created from the options object, configured by noops) and
// translatePeerCertificate passes certificates through unchanged.
// Export shapes match real node:_tls_common:
// { SecureContext, createSecureContext, translatePeerCertificate }.
// node:tls re-exports SecureContext/createSecureContext from here so the two
// modules stay consistent.
// Dependency-free ESM, browser-safe. No _RUNTIME_ access needed.
export class SecureContext {
  constructor(options = {}) {
    this.options = { ...options };
    this.context = {};
  }
  setCert(_cert) {}
  setKey(_key, _passphrase) {}
  addCACert(_cert) {}
}

// Port of Node lib/internal/tls/secure-context.js validateKeyOrCertOption
// + the ca/cert/key walk of configSecureContext (validation only): a
// truthy key/cert/ca must be a string or ArrayBufferView (Buffer,
// TypedArray, DataView); anything else throws ERR_INVALID_ARG_TYPE with
// Node's exact message (suffix rules mirror src/http.js's factory).
// Falsy values are skipped — false means "none".
// ponytail: ceiling — dhparam/crl/passphrase validation lives in the same
// Node function but no vendored test hinges on it yet.
const _invalidArgTypeSuffix = (actual) => {
  if (actual == null) return ` Received ${actual}`;
  if (typeof actual === "function") return ` Received function ${actual.name}`;
  if (typeof actual === "object") {
    if (actual.constructor?.name) {
      return ` Received an instance of ${actual.constructor.name}`;
    }
    return " Received [Object: null prototype] {}";
  }
  let inspected = typeof actual === "string" ? `'${actual}'` : String(actual);
  if (inspected.length > 28) inspected = `${inspected.slice(0, 25)}...`;
  return ` Received type ${typeof actual} (${inspected})`;
};

function validateKeyOrCertOption(name, value) {
  if (typeof value !== "string" && !ArrayBuffer.isView(value)) {
    const err = new TypeError(
      `The "${name}" property must be of type string or an instance of ` +
        `Buffer, TypedArray, or DataView.${_invalidArgTypeSuffix(value)}`,
    );
    err.code = "ERR_INVALID_ARG_TYPE";
    throw err;
  }
}

function _validateSecureContextOptions(options = {}) {
  const { ca, cert, key } = options;
  if (ca) {
    for (const value of Array.isArray(ca) ? ca : [ca]) {
      validateKeyOrCertOption("options.ca", value);
    }
  }
  if (cert) {
    for (const value of Array.isArray(cert) ? cert : [cert]) {
      validateKeyOrCertOption("options.cert", value);
    }
  }
  if (key) {
    if (Array.isArray(key)) {
      for (const value of key) {
        const pem = value?.pem !== undefined ? value.pem : value;
        validateKeyOrCertOption("options.key", pem);
      }
    } else {
      validateKeyOrCertOption("options.key", key);
    }
  }
}

export function createSecureContext(options) {
  _validateSecureContextOptions(options);
  return new SecureContext(options);
}

export function translatePeerCertificate(c) {
  if (c == null) return undefined;
  return c;
}

export default { SecureContext, createSecureContext, translatePeerCertificate };
