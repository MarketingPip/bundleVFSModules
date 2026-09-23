// node:_tls_wrap — Node internal module.
// Real Node exports { Server, TLSSocket, connect, createServer }.
//
// These are re-exported from the real tls port (src/tls.js) so the internal
// module and the public module can never drift apart. The browser has no
// raw-TLS API; see src/tls.js for the documented emulation gaps.
// Dependency-free ESM, browser-safe. No _RUNTIME_ access needed.
export { TLSSocket, Server, createServer, connect } from './tls.js';
import { TLSSocket, Server, createServer, connect } from './tls.js';

export default { TLSSocket, Server, createServer, connect };
