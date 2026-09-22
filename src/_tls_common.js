// node:_tls_common — Node internal TLS helpers.
//
// INTERIM minimal stub. The browser has no raw-TLS API, so SecureContext is
// an opaque handle and translatePeerCertificate passes certificates through
// unchanged. The tls worker (Wave C) will make this consistent with the tls
// port; until then the export shapes match real node:_tls_common
// (SecureContext, createSecureContext, translatePeerCertificate).
// Dependency-free ESM, browser-safe. No _RUNTIME_ access needed.
export class SecureContext {
  constructor(options = {}) {
    this.options = options;
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
