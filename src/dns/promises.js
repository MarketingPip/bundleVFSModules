// src/dns/promises.js — port of node:dns/promises for the browser runtime.
//
// Promise wrappers over the callback API in ../dns.js. This module is
// cycle-safe: it references ../dns.js bindings only inside function bodies,
// never at module top level, so either module may be imported first.
//
// There is deliberately NO default export: real node:dns/promises is a CJS
// module whose require() returns the exports object itself, and Node's
// CJS→ESM loader creates a facade copy whenever a default export exists.
// Omitting it keeps require('dns/promises') === require('dns').promises
// under CJS-style loading, exactly like real Node.

'use strict';

import dns, {
  lookup as lookupCb,
  lookupService as lookupServiceCb,
  resolve as resolveCb,
  resolve4 as resolve4Cb,
  resolve6 as resolve6Cb,
  resolveAny as resolveAnyCb,
  resolveCaa as resolveCaaCb,
  resolveCname as resolveCnameCb,
  resolveMx as resolveMxCb,
  resolveNaptr as resolveNaptrCb,
  resolveNs as resolveNsCb,
  resolvePtr as resolvePtrCb,
  resolveSoa as resolveSoaCb,
  resolveSrv as resolveSrvCb,
  resolveTlsa as resolveTlsaCb,
  resolveTxt as resolveTxtCb,
  reverse as reverseCb,
  getServers,
  setServers,
  getDefaultResultOrder,
  setDefaultResultOrder,
  NODATA, FORMERR, SERVFAIL, NOTFOUND, NOTIMP, REFUSED, BADQUERY,
  BADNAME, BADFAMILY, BADRESP, CONNREFUSED, TIMEOUT, EOF, FILE, NOMEM,
  DESTRUCTION, BADSTR, BADFLAGS, NONAME, BADHINTS, NOTINITIALIZED,
  LOADIPHLPAPI, ADDRGETNETWORKPARAMS, CANCELLED,
} from '../dns.js';

// Internal helpers shared from dns.js (not public node:dns API). dns.js
// imports this module, so its default export is NOT initialized when this
// module evaluates — never touch `dns` at module top level. These accessors
// run only after the import cycle has resolved, when the bindings are live.
function _internal(name) { return dns[name]; }
const _invalidArgType = (...a) => _internal('invalidArgType')(...a);
const _validateLookupServiceArgs = (...a) => _internal('validateLookupServiceArgs')(...a);

// `Resolver` must work as a class (new/instanceof/extends) but its
// implementation lives in dns.js, unavailable at our top level. A proxy
// defers every operation until first use, after the cycle resolves.
const _ResolverTarget = class {};
let _bridgeDone = false;
function _ensureBridge() {
  // Bridge _ResolverTarget.prototype to the real class so `class S extends
  // Resolver` gets a working prototype chain (the proxy must still report
  // the target's own non-configurable `prototype` for invariants).
  if (!_bridgeDone) {
    _bridgeDone = true;
    Object.setPrototypeOf(_ResolverTarget.prototype,
                          _internal('PromisesResolver').prototype);
  }
}
export const Resolver = new Proxy(_ResolverTarget, {
  construct(t, args, newTarget) {
    _ensureBridge();
    const PR = _internal('PromisesResolver');
    // `new Resolver()` → instance of PR; `class S extends Resolver` → keep S.
    const nt = (newTarget === Resolver) ? PR : newTarget;
    return Reflect.construct(PR, args, nt);
  },
  get(t, prop, receiver) {
    if (prop === 'prototype') {
      _ensureBridge();
      return Reflect.get(t, prop, receiver);
    }
    const PR = _internal('PromisesResolver');
    const v = PR[prop];
    return typeof v === 'function' ? v.bind(PR) : v;
  },
  getPrototypeOf() {
    return _internal('PromisesResolver').prototype;
  },
});

// Invoke a callback-style dns function and return a promise for its result.
// The call happens OUTSIDE the Promise executor: like real node:dns/promises,
// argument validation throws synchronously; only operational failures
// become rejections.
function asPromise(fn, args, shape) {
  let resolvePromise, rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  fn(...args, (err, ...rest) => {
    if (err) rejectPromise(err);
    else resolvePromise(shape ? shape(rest) : rest);
  });
  return promise;
}

export function lookup(hostname, options) {
  // The promises API has no callback parameter, so a function in the options
  // slot is a type error (real node:dns/promises throws ERR_INVALID_ARG_TYPE
  // synchronously) rather than being shifted like the callback API does.
  if (typeof options === 'function') {
    throw _invalidArgType('options', 'of type object or integer', options);
  }
  return asPromise(lookupCb, [hostname, options], ([address, family]) => {
    if (options && typeof options === 'object' && options.all) return address;
    return { address, family };
  });
}

export function lookupService(address, port) {
  // The promises API names only "address" and "port" in its missing-args
  // error, and it throws synchronously — unlike the callback API.
  _validateLookupServiceArgs(address, port, undefined, ['address', 'port']);
  return asPromise(lookupServiceCb, [address, port], ([hostname, service]) => ({ hostname, service }));
}

export function resolve(hostname, rrtype) {
  // No callback shift in the promises API: a function rrtype is a type error.
  if (typeof rrtype === 'function') {
    throw _invalidArgType('rrtype', 'of type string', rrtype);
  }
  return asPromise(resolveCb, [hostname, rrtype], ([records]) => records);
}

export function resolve4(hostname, options) {
  // Real node:dns/promises ignores a function in the options slot (the query
  // runs with default options) instead of treating it as a callback.
  if (typeof options === 'function') options = undefined;
  return asPromise(resolve4Cb, [hostname, options], ([records]) => records);
}

export function resolve6(hostname, options) {
  if (typeof options === 'function') options = undefined;
  return asPromise(resolve6Cb, [hostname, options], ([records]) => records);
}

export function resolveAny(hostname) {
  return asPromise(resolveAnyCb, [hostname], ([records]) => records);
}

export function resolveCaa(hostname) {
  return asPromise(resolveCaaCb, [hostname], ([records]) => records);
}

export function resolveCname(hostname) {
  return asPromise(resolveCnameCb, [hostname], ([records]) => records);
}

export function resolveMx(hostname) {
  return asPromise(resolveMxCb, [hostname], ([records]) => records);
}

export function resolveNaptr(hostname) {
  return asPromise(resolveNaptrCb, [hostname], ([records]) => records);
}

export function resolveNs(hostname) {
  return asPromise(resolveNsCb, [hostname], ([records]) => records);
}

export function resolvePtr(hostname) {
  return asPromise(resolvePtrCb, [hostname], ([records]) => records);
}

export function resolveSoa(hostname) {
  return asPromise(resolveSoaCb, [hostname], ([records]) => records);
}

export function resolveSrv(hostname) {
  return asPromise(resolveSrvCb, [hostname], ([records]) => records);
}

export function resolveTlsa(hostname) {
  return asPromise(resolveTlsaCb, [hostname], ([records]) => records);
}

export function resolveTxt(hostname) {
  return asPromise(resolveTxtCb, [hostname], ([records]) => records);
}

export function reverse(ip) {
  // Like node:dns/promises: the string-type check throws synchronously, but
  // a non-IP literal surfaces as a rejected promise (util.promisify turns the
  // callback API's synchronous EINVAL throw into a rejection).
  let resolvePromise, rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  try {
    reverseCb(ip, (err, hostnames) => (err ? rejectPromise(err) : resolvePromise(hostnames)));
  } catch (e) {
    if (typeof ip === 'string') rejectPromise(e);
    else throw e;
  }
  return promise;
}

// The promises Resolver subclass is defined in ../dns.js (so its extends
// clause never touches a cross-module binding at evaluation time) and
// re-exported here under the public name.
// (Resolver is defined via the lazy proxy above.)

export {
  getServers,
  setServers,
  getDefaultResultOrder,
  setDefaultResultOrder,
  NODATA, FORMERR, SERVFAIL, NOTFOUND, NOTIMP, REFUSED, BADQUERY,
  BADNAME, BADFAMILY, BADRESP, CONNREFUSED, TIMEOUT, EOF, FILE, NOMEM,
  DESTRUCTION, BADSTR, BADFLAGS, NONAME, BADHINTS, NOTINITIALIZED,
  LOADIPHLPAPI, ADDRGETNETWORKPARAMS, CANCELLED,
};

// Default export: the full named-export set (mirrors require('dns/promises')).
export default {
  Resolver,
  lookup, lookupService,
  resolve, resolve4, resolve6, resolveAny, resolveCaa, resolveCname,
  resolveMx, resolveNaptr, resolveNs, resolvePtr, resolveSoa, resolveSrv,
  resolveTlsa, resolveTxt, reverse,
  getServers, setServers, getDefaultResultOrder, setDefaultResultOrder,
  get NODATA() { return NODATA; }, get FORMERR() { return FORMERR; }, get SERVFAIL() { return SERVFAIL; }, get NOTFOUND() { return NOTFOUND; }, get NOTIMP() { return NOTIMP; }, get REFUSED() { return REFUSED; }, get BADQUERY() { return BADQUERY; },
  get BADNAME() { return BADNAME; }, get BADFAMILY() { return BADFAMILY; }, get BADRESP() { return BADRESP; }, get CONNREFUSED() { return CONNREFUSED; }, get TIMEOUT() { return TIMEOUT; }, get EOF() { return EOF; }, get FILE() { return FILE; }, get NOMEM() { return NOMEM; },
  get DESTRUCTION() { return DESTRUCTION; }, get BADSTR() { return BADSTR; }, get BADFLAGS() { return BADFLAGS; }, get NONAME() { return NONAME; }, get BADHINTS() { return BADHINTS; }, get NOTINITIALIZED() { return NOTINITIALIZED; },
  get LOADIPHLPAPI() { return LOADIPHLPAPI; }, get ADDRGETNETWORKPARAMS() { return ADDRGETNETWORKPARAMS; }, get CANCELLED() { return CANCELLED; },
};
