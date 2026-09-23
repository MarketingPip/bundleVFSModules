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

export function createSecureContext(options) {
  return new SecureContext(options);
}

export function translatePeerCertificate(c) {
  if (c == null) return undefined;
  return c;
}

export default { SecureContext, createSecureContext, translatePeerCertificate };
