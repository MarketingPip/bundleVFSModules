// src/dns.js — port of node:dns for the browser runtime.
//
// Strategy: DNS-over-HTTPS (DoH) via fetch(). The sandbox CSP
// (`connect-src *`) permits real outbound HTTPS, so every resolve* query,
// reverse() and lookup() work in the browser with zero native delegation.
//
// Transport details:
// - RFC 8484 wire format (application/dns-message) over fetch(). The DNS
//   codec itself is dns-packet (maintained, MIT) — it encodes queries and
//   decodes responses, replacing ~150 lines of hand-rolled DoH-JSON string
//   parsing. The fetch() transport stays hand-written: it is the only
//   network primitive the sandbox guarantees.
// - dohjs was evaluated and deliberately NOT adopted: its transport is
//   Node-https-based (not fetch, so not browser-suitable without fragile
//   indirection), its only unique helper is a 10-line query builder, and it
//   is GPL-3.0+ licensed — incompatible with this project's MIT shims.
//   dns-packet is the maintained protocol implementation dohjs itself
//   depends on, so adopting dns-packet captures the real value.
//
// Honest gaps vs node:dns (documented, not faked):
// - lookup() in Node is getaddrinfo-based: it honors /etc/hosts, mDNS, search
//   domains and the OS resolver configuration. The shim resolves literal IPs
//   and "localhost" locally and answers everything else via DoH. Results may
//   differ from the OS resolver (ordering, /etc/hosts entries).
// - setServers() accepts DoH endpoint URLs (https://...) and records plain
//   IP[:port] servers verbatim, but raw UDP/TCP DNS is impossible in the
//   browser, so IP[:port] entries cannot be used as transports. getServers()
//   always echoes back exactly what was set.
// - dns.resolveAny() is ENOTIMP in real Node too (c-ares deprecated ANY
//   queries); the shim mirrors that.
// - No DNSSEC validation.
// - resolveTlsa().data is a Uint8Array; real Node surfaces an ArrayBuffer.

'use strict';

import dnsPacket from 'dns-packet';
import { Buffer } from './buffer.js';

// 1. Runtime bridge (guarded: rewritten to the sandbox scope at load time,
//    undefined under real Node / direct import). The dns shim needs no
//    runtime services (fetch is a global), but the binding is kept per the
//    _RUNTIME_ contract so the rewrite has its canonical anchor.
const RT = (typeof globalThis._RUNTIME_ !== 'undefined')
  ? globalThis._RUNTIME_
  : undefined;
void RT;

// ---------------------------------------------------------------------------
// Constants (c-ares error names, mirrored from node:dns)
// ---------------------------------------------------------------------------

export const NODATA = 'ENODATA';
export const FORMERR = 'EFORMERR';
export const SERVFAIL = 'ESERVFAIL';
export const NOTFOUND = 'ENOTFOUND';
export const NOTIMP = 'ENOTIMP';
export const REFUSED = 'EREFUSED';
export const BADQUERY = 'EBADQUERY';
export const BADNAME = 'EBADNAME';
export const BADFAMILY = 'EBADFAMILY';
export const BADRESP = 'EBADRESP';
export const CONNREFUSED = 'ECONNREFUSED';
export const TIMEOUT = 'ETIMEOUT';
export const EOF = 'EOF';
export const FILE = 'EFILE';
export const NOMEM = 'ENOMEM';
export const DESTRUCTION = 'EDESTRUCTION';
export const BADSTR = 'EBADSTR';
export const BADFLAGS = 'EBADFLAGS';
export const NONAME = 'ENONAME';
export const BADHINTS = 'EBADHINTS';
export const NOTINITIALIZED = 'ENOTINITIALIZED';
export const LOADIPHLPAPI = 'ELOADIPHLPAPI';
export const ADDRGETNETWORKPARAMS = 'EADDRGETNETWORKPARAMS';
export const CANCELLED = 'ECANCELLED';

// dns.lookup() hints
export const ADDRCONFIG = 32;
export const V4MAPPED = 8;
export const ALL = 16;

// ---------------------------------------------------------------------------
// Validation helpers (mirror Node's ERR_* codes and messages)
// ---------------------------------------------------------------------------

// Attach a Node-style error code: real node:dns errors stringify as
// `TypeError [ERR_X]: message` (their toString includes the code), so install
// the same toString. `code` stays a plain enumerable property.
function coded(err, code) {
  err.code = code;
  Object.defineProperty(err, 'toString', {
    value() { return `${this.name} [${code}]: ${this.message}`; },
    configurable: true,
    writable: true,
  });
  return err;
}

export function invalidArgType(name, expected, actual, prop = false) {  // Mirrors Node's ERR_INVALID_ARG_TYPE "Received ..." rendering.
  // prop=true → 'The "options.x" property must be ...' (lookup options).
  let received;
  if (actual === null || actual === undefined) received = `${actual}`;
  else if (typeof actual === 'function') received = `function ${actual.name}`;
  else if (typeof actual === 'object') {
    received = `an instance of ${(actual.constructor && actual.constructor.name) || 'Object'}`;
  } else if (typeof actual === 'string') received = `type string ('${actual}')`;
  else received = `type ${typeof actual} (${String(actual)})`;
  return coded(
    new TypeError(`The "${name}" ${prop ? 'property' : 'argument'} must be ${expected}. Received ${received}`),
    'ERR_INVALID_ARG_TYPE',
  );
}

function invalidArgInstance(name, actual) {
  // 'must be an instance of Array' variant (e.g. setServers).
  let received;
  if (actual === null || actual === undefined) received = `${actual}`;
  else if (typeof actual === 'object') {
    received = `an instance of ${(actual.constructor && actual.constructor.name) || 'Object'}`;
  } else if (typeof actual === 'string') received = `type string ('${actual}')`;
  else received = `type ${typeof actual} (${String(actual)})`;
  return coded(
    new TypeError(`The "${name}" argument must be an instance of Array. Received ${received}`),
    'ERR_INVALID_ARG_TYPE',
  );
}

function missingArgs(names) {
  // Node's ERR_MISSING_ARGS: 'The "a" and "b" arguments must be specified'
  // (two names, no Oxford comma) vs 'The "a", "b", and "c" arguments ...'.
  const quoted = names.map((n) => `"${n}"`);
  let list;
  if (quoted.length === 1) list = quoted[0];
  else if (quoted.length === 2) list = `${quoted[0]} and ${quoted[1]}`;
  else list = `${quoted.slice(0, -1).join(', ')}, and ${quoted[quoted.length - 1]}`;
  return coded(
    new TypeError(`The ${list} argument${names.length > 1 ? 's' : ''} must be specified`),
    'ERR_MISSING_ARGS',
  );
}

function dnsSetServersFailed(servers) {
  // Thrown by setServers() while queries are in flight, mirroring c-ares.
  const list = servers.map((s) => `'${s}'`).join(', ');
  return coded(
    new Error(`c-ares failed to set servers: "There are pending queries." [[ ${list} ]]`),
    'ERR_DNS_SET_SERVERS_FAILED',
  );
}

const emittedDeprecations = new Set();
function emitDeprecationWarning(code, message) {
  // Node dedupes deprecation warnings: each code is emitted once per process.
  if (emittedDeprecations.has(code)) return;
  emittedDeprecations.add(code);
  // process.emitWarning where available (Node, sandbox); silent elsewhere.
  const proc = globalThis.process;
  if (proc && typeof proc.emitWarning === 'function') {
    proc.emitWarning(message, { code, type: 'DeprecationWarning' });
  }
}

function validateString(value, name) {
  if (typeof value !== 'string') throw invalidArgType(name, 'of type string', value);
}

function validateFunction(value, name) {
  if (typeof value !== 'function') throw invalidArgType(name, 'of type function', value);
}

function validateOneOf(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw coded(
      new TypeError(`The argument '${name}' must be one of: ${allowed.map((a) => `'${a}'`).join(', ')}. Received ${typeof value === 'string' ? `'${value}'` : String(value)}`),
      'ERR_INVALID_ARG_VALUE',
    );
  }
}

function invalidArgValue(what, received) {
  return coded(
    new TypeError(`The argument '${what}' is invalid. Received ${typeof received === 'string' ? `'${received}'` : String(received)}`),
    'ERR_INVALID_ARG_VALUE',
  );
}

// DNS-shaped errors: `new Error(`${syscall} ${code} ${hostname}`)` with
// .code / .syscall / .hostname, exactly like Node's DNSException.
function dnsError(syscall, code, hostname) {
  const message = hostname ? `${syscall} ${code} ${hostname}` : `${syscall} ${code}`;
  const err = coded(new Error(message), code);
  err.syscall = syscall;
  err.hostname = hostname;
  return err;
}

function validatePort(port) {
  // Mirrors Node's validatePort: numeric strings ('80') are accepted;
  // anything else out of range throws ERR_SOCKET_BAD_PORT.
  const num = typeof port === 'string' && port.trim() !== '' ? Number(port) : port;
  if (typeof port === 'function' || !Number.isInteger(num) || num < 0 || num > 65535) {
    let received;
    if (typeof port === 'function') received = 'function ';
    else if (typeof port === 'string') received = `type string ('${port}')`;
    else if (typeof port === 'number') received = `type number (${String(port)})`;
    else received = `type ${typeof port} (${String(port)})`;
    throw coded(
      new RangeError(`Port should be >= 0 and < 65536. Received ${received}.`),
      'ERR_SOCKET_BAD_PORT',
    );
  }
}

function validateIPAddress(value, what) {
  if (!isIPv4(value) && !isIPv6(value)) {
    throw coded(
      new TypeError(`Invalid IP address${what ? `: ${what}` : '.'}`),
      typeof what === 'string' ? 'ERR_INVALID_IP_ADDRESS' : 'ERR_INVALID_ARG_VALUE',
    );
  }
}

// ---------------------------------------------------------------------------
// IP literal helpers
// ---------------------------------------------------------------------------

function isIPv4(s) {
  if (typeof s !== 'string') return false;
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isIPv6(s) {
  if (typeof s !== 'string' || !s.includes(':')) return false;
  // Use the URL parser as a strict validator.
  try {
    const u = new URL(`http://[${s}]/`);
    return u.hostname === s.toLowerCase() || u.hostname.replace(/^\[(.*)\]$/, '$1') === s.toLowerCase();
  } catch { return false; }
}

function ipFamily(ip) {
  if (isIPv4(ip)) return 4;
  if (isIPv6(ip)) return 6;
  return 0;
}

function expandIPv6(ip) {
  // Returns 8 groups of 4 lowercase hex digits.
  const halves = ip.split('::');
  if (halves.length > 2) throw new Error('invalid');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  // Handle embedded IPv4 (e.g. ::ffff:1.2.3.4).
  const norm = (groups) => groups.flatMap((g) => {
    if (g.includes('.')) {
      const b = g.split('.').map(Number);
      return [(b[0] * 256 + b[1]).toString(16), (b[2] * 256 + b[3]).toString(16)];
    }
    return [g];
  });
  const l = norm(left); const r = norm(right);
  const fill = new Array(8 - l.length - r.length).fill('0');
  if (fill.length < 0) throw new Error('invalid');
  return [...l, ...fill, ...r].map((g) => g.padStart(4, '0').toLowerCase());
}

function ipToArpa(ip) {
  if (isIPv4(ip)) return ip.split('.').reverse().join('.') + '.in-addr.arpa';
  const nibbles = expandIPv6(ip).join('').split('').reverse().join('.');
  return nibbles + '.ip6.arpa';
}

// ---------------------------------------------------------------------------
// DoH transport (dependency-free, fetch-based)
// ---------------------------------------------------------------------------

const DEFAULT_DOH_SERVERS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/dns-query',
];

const VALID_RRTYPES = ['A', 'AAAA', 'ANY', 'CAA', 'CNAME', 'MX', 'NAPTR', 'NS', 'PTR', 'SOA', 'SRV', 'TLSA', 'TXT'];

const SYSCALL_FOR_TYPE = {
  A: 'queryA', AAAA: 'queryAaaa', CNAME: 'queryCname', MX: 'queryMx',
  NS: 'queryNs', TXT: 'queryTxt', SRV: 'querySrv', SOA: 'querySoa',
  PTR: 'queryPtr', NAPTR: 'queryNaptr', CAA: 'queryCaa', TLSA: 'queryTlsa',
  ANY: 'queryAny',
};

function isDohUrl(s) {
  return typeof s === 'string' && /^https?:\/\//i.test(s);
}

// Split "[v6]", "[v6]:port", "host", "host:port", "bare:v6" into [host, port].
// Throws ERR_INVALID_IP_ADDRESS for anything that is not an IP literal with
// an optional numeric port. DoH URLs are accepted verbatim as a browser
// extension (documented); they bypass IP validation.
function invalidIP(entry) {
  return coded(
    new TypeError(`Invalid IP address: ${entry}`),
    'ERR_INVALID_IP_ADDRESS',
  );
}

function normalizeServerEntry(entry) {
  let host = entry;
  let port = '';
  if (entry.startsWith('[')) {
    const end = entry.indexOf(']');
    if (end === -1) throw invalidIP(entry);
    host = entry.slice(1, end);
    const rest = entry.slice(end + 1);
    if (rest !== '') {
      if (!rest.startsWith(':')) throw invalidIP(entry);
      port = rest.slice(1);
    }
  } else {
    const first = entry.indexOf(':');
    if (first !== -1 && first !== entry.lastIndexOf(':')) {
      host = entry; // bare IPv6 — a port would be ambiguous
    } else if (first !== -1) {
      host = entry.slice(0, first);
      port = entry.slice(first + 1);
    }
  }
  if (port !== '' && !/^\d+$/.test(port)) throw invalidIP(entry);
  if (!isIPv4(host) && !isIPv6(host)) throw invalidIP(entry);
  // Like Node: default port 53 is dropped, brackets are dropped from bare
  // IPv6, non-default ports are kept (bracketed for IPv6).
  if (port === '' || Number(port) === 53) return host;
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

function validateServerList(servers) {
  if (!Array.isArray(servers)) throw invalidArgInstance('servers', servers);
  const out = [];
  // Holes are skipped (Node semantics); the length is re-read so a getter
  // that mutates the array is honoured the same way.
  for (let i = 0; i < servers.length; i++) {
    if (!(i in servers)) continue;
    const s = servers[i];
    if (typeof s !== 'string') throw invalidArgType(`servers[${i}]`, 'of type string', s);
    out.push(isDohUrl(s) ? s : normalizeServerEntry(s));
  }
  return out;
}

function usableDohServers(servers) {
  const usable = (servers || []).filter(isDohUrl);
  return usable.length ? usable : DEFAULT_DOH_SERVERS.slice();
}

// DoH rcode strings (dns-packet decodes the numeric RCODE to a name):
// NOERROR, FORMERR, SERVFAIL, NXDOMAIN, NOTIMP, REFUSED, ...
function rcodeToCode(rcode) {
  switch (rcode) {
    case 'NXDOMAIN': return NOTFOUND;   // ENOTFOUND
    case 'SERVFAIL': return SERVFAIL;   // ESERVFAIL
    case 'FORMERR': return FORMERR;     // EFORMERR
    case 'NOTIMP': return NOTIMP;       // ENOTIMP
    case 'REFUSED': return REFUSED;     // EREFUSED
    default: return BADRESP;            // EBADRESP
  }
}

function base64UrlEncode(bytes) {
  // DNS wire packets are small; a binary-string pass through btoa is fine.
  // btoa exists in every browser and in Node 16+, so the transport needs no
  // Buffer global here.
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function dohFetchOne(base, name, type, signal) {
  // RFC 8484 §4.1 GET: ?dns=<base64url(wire)>, Accept: application/dns-message.
  // The DNS ID is 0 per the RFC's cache-friendliness guidance; dns-packet
  // builds the query (recursion desired, like any stub resolver).
  const wire = dnsPacket.encode({
    type: 'query',
    id: 0,
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ type, name }],
  });
  const sep = base.includes('?') ? '&' : '?';
  const url = `${base}${sep}dns=${base64UrlEncode(wire)}`;
  const res = await fetch(url, { headers: { accept: 'application/dns-message' }, signal });
  if (!res.ok) {
    const err = new Error(`DoH request failed: ${res.status}`);
    err.code = CONNREFUSED; // ECONNREFUSED
    throw err;
  }
  const raw = await res.arrayBuffer();
  let body;
  try {
    body = dnsPacket.decode(Buffer.from(raw));
  } catch {
    const e = new Error('bad DoH response'); e.code = BADRESP; throw e;
  }
  if (!body || body.type !== 'response' || !Array.isArray(body.answers)) {
    const e = new Error('bad DoH response'); e.code = BADRESP; throw e;
  }
  return body;
}

// Query every configured DoH server in order; the first NOERROR answer wins.
// NXDOMAIN (ENOTFOUND) is terminal — no point trying the next server.
async function dohQuery(servers, name, type, { signal, timeoutMs } = {}) {
  if (typeof globalThis.fetch !== 'function') {
    throw dnsError('query', 'EAI_AGAIN', name);
  }
  let timer;
  let timedOut = false;
  let ctrl = null;
  let effSignal = signal;
  if (timeoutMs != null) {
    ctrl = new AbortController();
    effSignal = ctrl.signal;
    if (signal) {
      if (signal.aborted) ctrl.abort(signal.reason);
      else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
    }
    timer = setTimeout(() => { timedOut = true; ctrl.abort(new Error('timeout')); }, timeoutMs);
  }
  try {
    let lastErr = null;
    for (const base of usableDohServers(servers)) {
      try {
        const body = await dohFetchOne(base, name, type, effSignal);
        if (body.rcode === 'NOERROR' || body.rcode === 'NXDOMAIN') return body; // terminal
        lastErr = dnsError(SYSCALL_FOR_TYPE[type] || 'query', rcodeToCode(body.rcode), name);
        // SERVFAIL etc: try the next server.
      } catch (e) {
        if (timedOut) {
          const te = new Error('DoH query timed out');
          te.code = TIMEOUT; // ETIMEOUT
          throw te;
        }
        if (e && e.name === 'AbortError') {
          // Some fetch implementations reject with a bare AbortError on
          // abort; recover the real reason from the signal when available.
          const reason = effSignal && effSignal.reason;
          if (reason && reason.code) throw reason;
          throw e;
        }
        lastErr = e && e.code ? e : coded(new Error(String((e && e.message) || e)), CONNREFUSED);
      }
    }
    throw lastErr || coded(new Error('DoH query failed'), CONNREFUSED);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sameDnsName(a, b) {
  const norm = (s) => String(s).toLowerCase().replace(/\.$/, '');
  return norm(a) === norm(b);
}

function stripDot(s) {
  return String(s).replace(/\.$/, '');
}

// ---------------------------------------------------------------------------
// Wire answer → Node record shapes.
//
// dns-packet decodes rdata into structured values; this maps them onto the
// exact shapes Node returns. Field names were verified against
// nodejs/node v24.20.0 src/cares_wrap.cc (Parse*Reply templates).
// ---------------------------------------------------------------------------

function mapRecord(type, data) {
  if (data === null || data === undefined) return null;
  switch (type) {
    case 'A':
    case 'AAAA':
      // dns-packet: address string.
      return typeof data === 'string' ? data : null;
    case 'CNAME':
    case 'NS':
    case 'PTR':
      // dns-packet: target name string (may carry a trailing dot).
      return typeof data === 'string' ? stripDot(data) : null;
    case 'MX':
      // dns-packet: { preference, exchange } → Node { priority, exchange }.
      return typeof data.exchange === 'string'
        ? { priority: data.preference, exchange: stripDot(data.exchange) }
        : null;
    case 'TXT':
      // dns-packet: Buffer[] of character-strings → Node string[].
      return Array.isArray(data)
        ? data.map((chunk) => Buffer.from(chunk).toString())
        : null;
    case 'SRV':
      // dns-packet: { priority, weight, port, target } → Node { ..., name }.
      return typeof data.target === 'string'
        ? {
            priority: data.priority, weight: data.weight,
            port: data.port, name: stripDot(data.target),
          }
        : null;
    case 'SOA':
      // dns-packet: { mname, rname, ..., minimum } → Node { nsname,
      // hostmaster, ..., minttl }.
      return typeof data.mname === 'string'
        ? {
            nsname: stripDot(data.mname),
            hostmaster: stripDot(data.rname),
            serial: data.serial, refresh: data.refresh, retry: data.retry,
            expire: data.expire, minttl: data.minimum,
          }
        : null;
    case 'CAA':
      // dns-packet: { flags, tag, value } → Node { critical, [tag]: value }.
      return typeof data.tag === 'string'
        ? { critical: (data.flags & 128) ? 128 : 0, [data.tag]: String(data.value) }
        : null;
    case 'NAPTR':
      // dns-packet: { ..., services, ... } → Node { ..., service, ... }.
      return typeof data === 'object'
        ? {
            flags: String(data.flags), service: String(data.services),
            regexp: String(data.regexp),
            replacement: stripDot(String(data.replacement)),
            order: data.order, preference: data.preference,
          }
        : null;
    case 'TLSA':
      // dns-packet: { usage, selector, matchingType, certificate } → Node
      // { certUsage, selector, match, data }. (Node's data is an ArrayBuffer;
      // we hand back a Uint8Array, which is friendlier in the sandbox.)
      return data.certificate
        ? {
            certUsage: data.usage, selector: data.selector,
            match: data.matchingType, data: new Uint8Array(data.certificate),
          }
        : null;
    default:
      return null;
  }
}

function answersWithTtl(body, name, type) {
  const out = [];
  for (const a of (body && body.answers) || []) {
    if (a.type !== type) continue;
    if (!sameDnsName(a.name, name)) continue;
    const rec = mapRecord(type, a.data);
    if (rec !== null && rec !== undefined) out.push({ value: rec, ttl: a.ttl });
  }
  return out;
}

function answersFor(body, name, type) {
  return answersWithTtl(body, name, type).map((e) => e.value);
}

// Follow CNAME chains (up to 5 hops) for A/AAAA, like a stub resolver does.
async function queryWithCname(servers, name, type, opts) {
  let current = name;
  for (let hop = 0; hop < 6; hop++) {
    const body = await dohQuery(servers, current, type, opts);
    const entries = answersWithTtl(body, current, type);
    if (entries.length) {
      return {
        records: entries.map((e) => e.value),
        ttls: entries.map((e) => e.ttl),
        body, finalName: current,
      };
    }
    if (body.rcode !== 'NOERROR') return { records: [], ttls: [], body, finalName: current };
    const cnames = answersFor(body, current, 'CNAME');
    if (!cnames.length) return { records: [], ttls: [], body, finalName: current };
    current = cnames[0];
  }
  const body = await dohQuery(servers, current, type, opts);
  const entries = answersWithTtl(body, current, type);
  return {
    records: entries.map((e) => e.value),
    ttls: entries.map((e) => e.ttl),
    body, finalName: current,
  };
}

function throwForStatus(body, syscall, hostname) {
  // NOERROR with no usable answers → ENODATA; NXDOMAIN → ENOTFOUND; else mapped.
  if (body.rcode === 'NOERROR') throw dnsError(syscall, NODATA, hostname);
  throw dnsError(syscall, rcodeToCode(body.rcode), hostname);
}

function mapTransportError(e, syscall, hostname, { forLookup, signal } = {}) {
  if (e && e.name === 'AbortError') {
    const reason = signal && signal.aborted ? signal.reason : undefined;
    const code = (reason && reason.code) || e.code;
    if (code === CANCELLED || /cancel/i.test(String((reason && reason.message) || e.message || ''))) {
      return dnsError(syscall, CANCELLED, hostname);
    }
    return dnsError(syscall, TIMEOUT, hostname);
  }
  if (e && e.code) {
    const err = new Error(`${syscall} ${e.code}${hostname ? ` ${hostname}` : ''}`);
    err.code = e.code; err.syscall = syscall; err.hostname = hostname;
    return err;
  }
  // Unreachable DoH endpoint: lookup() → EAI_AGAIN (like getaddrinfo),
  // resolve*() → ECONNREFUSED (like a refused UDP server).
  return dnsError(syscall, forLookup ? 'EAI_AGAIN' : CONNREFUSED, hostname);
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let defaultServers = DEFAULT_DOH_SERVERS.slice();
let defaultResultOrder = 'verbatim'; // 'verbatim' | 'ipv4first' | 'ipv6first'

export function getServers() {
  return defaultServers.slice();
}

export function setServers(servers) {
  // Real node:dns's module-level setServers() never throws for pending
  // queries (only Resolver instances do); mirror that.
  defaultServers = validateServerList(servers);
}

export function getDefaultResultOrder() {
  return defaultResultOrder;
}

export function setDefaultResultOrder(order) {
  validateOneOf(order, ['ipv4first', 'ipv6first', 'verbatim'], 'dnsOrder');
  defaultResultOrder = order;
}

// ---------------------------------------------------------------------------
// Internal: run a query against a Resolver-like state
// ---------------------------------------------------------------------------

function orderAddresses(records, order) {
  if (order === 'ipv4first') {
    return [...records.filter((r) => r.family === 4), ...records.filter((r) => r.family !== 4)];
  }
  if (order === 'ipv6first') {
    return [...records.filter((r) => r.family === 6), ...records.filter((r) => r.family !== 6)];
  }
  return records;
}

async function lookupImpl(state, hostname, options) {
  const family = options.family || 0;
  // order: explicit option wins; verbatim:true → resolver order,
  // verbatim:false → IPv4 first; otherwise the module default result order.
  const order = options.order
    || (options.verbatim === true ? 'verbatim'
      : options.verbatim === false ? 'ipv4first'
      : state.resultOrder);

  // 0. Falsy hostname (DEP0118 path): getaddrinfo(NULL) → { address: null, family: 4 }.
  if (hostname == null) {
    const rec = { address: null, family: 4 };
    return options.all ? [rec] : rec;
  }

  // 1. Literal IPs resolve locally, family is ignored (matches Node).

  // 1. Literal IPs resolve locally, family is ignored (matches Node).
  const lit = ipFamily(hostname);
  if (lit === 4 || lit === 6) {
    const rec = { address: hostname, family: lit };
    return options.all ? [rec] : rec;
  }

  // 2. localhost: the one /etc/hosts entry we can honor without the OS.
  if (hostname.toLowerCase() === 'localhost') {
    let recs = [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }];
    if (family === 4) recs = recs.filter((r) => r.family === 4);
    if (family === 6) recs = recs.filter((r) => r.family === 6);
    recs = orderAddresses(recs, order);
    if (!recs.length) throw dnsError('getaddrinfo', NOTFOUND, hostname);
    return options.all ? recs : recs[0];
  }

  // 3. Everything else via DoH.
  const types = family === 4 ? ['A'] : family === 6 ? ['AAAA'] : ['A', 'AAAA'];
  const settled = await Promise.all(types.map((t) =>
    queryWithCname(state.servers, hostname, t, { signal: state.signal, timeoutMs: state.timeout })
      .then(
        (r) => ({ ok: true, type: t, ...r }),
        (e) => ({ ok: false, type: t, err: e }),
      ),
  ));
  let records = [];
  let transportErr = null;
  for (const s of settled) {
    if (!s.ok) {
      if (s.err && (s.err.code === 'EAI_AGAIN' || s.err.code === CONNREFUSED || s.err.code === TIMEOUT || s.err.code === CANCELLED)) {
        if (s.err.code === CANCELLED) throw dnsError('getaddrinfo', CANCELLED, hostname);
        transportErr = transportErr || s.err;
      } else if (s.err && s.err.code) {
        transportErr = transportErr || s.err;
      }
      continue;
    }
    const fam = s.type === 'A' ? 4 : 6;
    for (const addr of s.records) records.push({ address: addr, family: fam });
  }

  // hints: V4MAPPED — map IPv4 results into IPv6 when family is 6.
  if (family === 6 && records.length && !records.some((r) => r.family === 6) && (options.hints & V4MAPPED)) {
    records = records.map((r) => ({ address: `::ffff:${r.address}`, family: 6 }));
  }

  records = orderAddresses(records, order);

  if (!records.length) {
    if (transportErr) throw mapTransportError(transportErr, 'getaddrinfo', hostname, { forLookup: true });
    throw dnsError('getaddrinfo', NOTFOUND, hostname);
  }
  return options.all ? records : records[0];
}

async function resolveImpl(state, hostname, type) {
  const syscall = SYSCALL_FOR_TYPE[type];
  const { records, ttls, body } = await queryWithCname(
    state.servers, hostname, type,
    { signal: state.signal, timeoutMs: state.timeout },
  ).catch((e) => { throw mapTransportError(e, syscall, hostname, { signal: state.signal }); });
  if (!records.length) throwForStatus(body, syscall, hostname);
  return { records, ttls };
}

// ---------------------------------------------------------------------------
// Callback API
// ---------------------------------------------------------------------------

function normalizeLookupArgs(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = undefined; }
  else if (typeof options === 'number') { options = { family: options }; }
  // Hostname: truthy non-strings throw; falsy values (including '') emit
  // DEP0118 and behave like getaddrinfo(NULL) → { address: null, family: 4 }.
  if (typeof hostname !== 'string') {
    if (hostname) throw invalidArgType('hostname', 'of type string', hostname);
  }
  if (!hostname) {
    emitDeprecationWarning(
      'DEP0118',
      `The provided hostname "${String(hostname)}" is not a valid hostname, ` +
      'and is supported in the dns module solely for compatibility.',
    );
    hostname = null;
  } else if (hostname.includes('\0')) {
    // Node appends the offending value with control characters \x-escaped.
    const shown = hostname.replace(/[\0-\x1f\x7f]/g,
      (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
    throw coded(
      new TypeError(`The argument 'hostname' must be a string without null bytes. Received '${shown}'`),
      'ERR_INVALID_ARG_VALUE',
    );
  }
  validateFunction(callback, 'callback');
  if (options == null) options = {};
  if (typeof options !== 'object') throw invalidArgType('options', 'of type object or integer', options);
  // family: 0/4/6, the strings 'IPv4'/'IPv6', or null/undefined → 0.
  let family = options.family;
  if (family === 'IPv4') family = 4;
  else if (family === 'IPv6') family = 6;
  else if (family === undefined || family === null) family = 0;
  if (![0, 4, 6].includes(family)) {
    throw coded(
      new TypeError(`The property 'options.family' must be one of: 0, 4, 6. Received ${typeof family === 'string' ? `'${family}'` : String(family)}`),
      'ERR_INVALID_ARG_VALUE',
    );
  }
  // hints: numeric bitmask drawn from ADDRCONFIG | V4MAPPED | ALL (56).
  let hints = 0;
  if (options.hints !== undefined && options.hints !== null) {
    if (typeof options.hints !== 'number') throw invalidArgType('options.hints', 'of type number', options.hints, true);
    hints = options.hints >>> 0;
    if (hints & ~56) throw invalidArgValue('hints', hints);
  }
  if (options.verbatim !== undefined && options.verbatim !== null && typeof options.verbatim !== 'boolean') {
    throw invalidArgType('options.verbatim', 'of type boolean', options.verbatim, true);
  }
  if (options.all !== undefined && options.all !== null && typeof options.all !== 'boolean') {
    throw invalidArgType('options.all', 'of type boolean', options.all, true);
  }
  let order;
  if (options.order !== undefined && options.order !== null) {
    if (!['verbatim', 'ipv4first', 'ipv6first'].includes(options.order)) {
      throw coded(
        new TypeError(`The property 'options.order' must be one of: 'verbatim', 'ipv4first', 'ipv6first'. Received ${typeof options.order === 'string' ? `'${options.order}'` : String(options.order)}`),
        'ERR_INVALID_ARG_VALUE',
      );
    }
    order = options.order;
  }
  return { opts: { hostname, family, hints, verbatim: options.verbatim, all: !!options.all, order }, callback };
}

function asyncCallback(callback, fn) {
  // Node always invokes DNS callbacks asynchronously.
  queueMicrotask(() => {
    try {
      fn();
    } catch (e) {
      callback(e);
    }
  });
}

// Same, but counts the query as in-flight on `state` from the synchronous
// call until the user callback runs — so cancel() issued synchronously
// afterwards still finds it, and setServers() can refuse while queries are
// pending (ERR_DNS_SET_SERVERS_FAILED, like c-ares). The counter is
// decremented BEFORE the user callback runs (c-ares removes a query from its
// active set before invoking the callback), so `await p; setServers(...)`
// never observes a stale pending count. Double-callbacks are guarded.
function asyncTracked(state, callback, fn) {
  state._pending++;
  let settled = false;
  const done = (...args) => {
    if (settled) return;
    settled = true;
    state._pending--;
    callback(...args);
  };
  asyncCallback(callback, async () => {
    try {
      await fn(done);
    } catch (e) {
      done(e);
    }
  });
}

// Default (module-level) resolver state. dns/promises delegates here, so
// setServers()/cancel() stay in sync across both APIs.
const defaultState = {
  get servers() { return defaultServers; },
  get resultOrder() { return defaultResultOrder; },
  get timeout() { return undefined; },
  signal: undefined,
  _pending: 0,
};

export function lookup(hostname, options, callback) {
  const { opts, callback: cb } = normalizeLookupArgs(hostname, options, callback);
  asyncTracked(defaultState, cb, async (done) => {
    try {
      const res = await lookupImpl(defaultState, opts.hostname, opts);
      if (opts.all) done(null, res);
      else done(null, res.address, res.family);
    } catch (e) {
      done(e);
    }
  });
}

const WELL_KNOWN_PORTS = {
  20: 'ftp-data', 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp',
  53: 'domain', 67: 'dhcps', 68: 'dhcpc', 69: 'tftp', 80: 'http',
  110: 'pop3', 119: 'nntp', 123: 'ntp', 143: 'imap', 161: 'snmp',
  162: 'snmptrap', 179: 'bgp', 389: 'ldap', 443: 'https', 445: 'microsoft-ds',
  465: 'smtps', 514: 'syslog', 515: 'printer', 546: 'dhcpv6-client',
  547: 'dhcpv6-server', 587: 'submission', 636: 'ldaps', 993: 'imaps',
  995: 'pop3s', 1433: 'ms-sql-s', 1521: 'oracle', 3306: 'mysql',
  3389: 'ms-wbt-server', 5432: 'postgresql', 5900: 'vnc', 6379: 'redis',
  8080: 'http-alt', 8443: 'https-alt',
};

export function validateLookupServiceArgs(address, port, callback, missingNames) {
  // Missing-argument shape mirrors Node exactly: the callback API names all
  // three arguments, the promises API names only address and port.
  if (port === undefined || (missingNames.length === 3 && callback === undefined)) {
    throw missingArgs(missingNames);
  }
  validateString(address, 'address');
  if (!isIPv4(address) && !isIPv6(address)) throw invalidArgValue('address', address);
  validatePort(port);
  if (missingNames.length === 3) validateFunction(callback, 'callback');
}

export function lookupService(address, port, callback) {
  validateLookupServiceArgs(address, port, callback, ['address', 'port', 'callback']);
  asyncTracked(defaultState, callback, async (done) => {
    try {
      // Loopback addresses resolve via the hosts table in Node; DoH has no
      // PTR for them, so answer locally like lookup() does.
      let hostname;
      if (address === '::1' || (isIPv4(address) && address.split('.')[0] === '127')) {
        hostname = 'localhost';
      } else {
        const { records: hostnames } = await resolveImpl(defaultState, ipToArpa(address), 'PTR');
        hostname = hostnames[0];
      }
      const service = WELL_KNOWN_PORTS[port] || String(port);
      done(null, hostname, service);
    } catch (e) {
      if (e && e.syscall === 'queryPtr') {
        const err = dnsError('getnameinfo', e.code, address);
        done(err);
        return;
      }
      done(e);
    }
  });
}

function normalizeResolveArgs(hostname, rrtype, callback, fnName) {
  if (typeof rrtype === 'function') { callback = rrtype; rrtype = 'A'; }
  validateString(hostname, 'name');
  if (rrtype === undefined) rrtype = 'A';
  // Non-string rrtype (e.g. an Array) is a type error; a string that is not a
  // known type is a value error — matches Node exactly.
  if (typeof rrtype !== 'string') throw invalidArgType('rrtype', 'of type string', rrtype);
  if (!VALID_RRTYPES.includes(rrtype)) {
    throw coded(
      new TypeError(`The argument 'rrtype' is invalid. Received '${rrtype}'`),
      'ERR_INVALID_ARG_VALUE',
    );
  }
  validateFunction(callback, 'callback');
  void fnName;
  return { hostname, rrtype, callback };
}

function makeResolveFn(type) {
  const fn = function resolveX(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    validateString(hostname, 'name');
    validateFunction(callback, 'callback');
    const wantTtl = !!(options && typeof options === 'object' && options.ttl);
    asyncTracked(defaultState, callback, async (done) => {
      try {
        const { records, ttls } = await resolveImpl(defaultState, hostname, type);
        if (wantTtl && (type === 'A' || type === 'AAAA')) {
          // { ttl: true } → [{ address, ttl }]
          done(null, records.map((address, i) => ({ address, ttl: ttls[i] })));
        } else if (type === 'SOA') {
          done(null, records[0]); // single object, like Node
        } else {
          done(null, records);
        }
      } catch (e) {
        done(e);
      }
    });
  };
  return fn;
}

export const resolve4 = makeResolveFn('A');
export const resolve6 = makeResolveFn('AAAA');
export const resolveCname = makeResolveFn('CNAME');
export const resolveMx = makeResolveFn('MX');
export const resolveNs = makeResolveFn('NS');
export const resolveTxt = makeResolveFn('TXT');
export const resolveSrv = makeResolveFn('SRV');
export const resolveSoa = makeResolveFn('SOA');
export const resolvePtr = makeResolveFn('PTR');
export const resolveNaptr = makeResolveFn('NAPTR');
export const resolveCaa = makeResolveFn('CAA');
export const resolveTlsa = makeResolveFn('TLSA');

export function resolve(hostname, rrtype, callback) {
  const { hostname: h, rrtype: t, callback: cb } = normalizeResolveArgs(hostname, rrtype, callback, 'resolve');
  const table = {
    A: resolve4, AAAA: resolve6, CNAME: resolveCname, MX: resolveMx,
    NS: resolveNs, TXT: resolveTxt, SRV: resolveSrv, SOA: resolveSoa,
    PTR: resolvePtr, NAPTR: resolveNaptr, CAA: resolveCaa, TLSA: resolveTlsa,
  };
  if (t === 'ANY') {
    // Real Node: resolveAny is ENOTIMP (c-ares deprecated ANY queries).
    asyncTracked(defaultState, cb, async (done) => done(dnsError('queryAny', NOTIMP, h)));
    return;
  }
  table[t](h, cb);
}

export function resolveAny(hostname, callback) {
  validateString(hostname, 'name');
  validateFunction(callback, 'callback');
  asyncTracked(defaultState, callback, async (done) => done(dnsError('queryAny', NOTIMP, hostname)));
}

export function reverse(ip, callback) {
  validateString(ip, 'ip');
  if (!isIPv4(ip) && !isIPv6(ip)) {
    // Node throws synchronously (before any callback) for non-IP input.
    throw dnsError('getHostByAddr', 'EINVAL', ip);
  }
  validateFunction(callback, 'callback');
  asyncTracked(defaultState, callback, async (done) => {
    try {
      const { records: hostnames } = await resolveImpl(defaultState, ipToArpa(ip), 'PTR');
      done(null, hostnames);
    } catch (e) {
      if (e && e.syscall === 'queryPtr') done(dnsError('getHostByAddr', e.code, ip));
      else done(e);
    }
  });
}

// ---------------------------------------------------------------------------
// Resolver class (mirrors node:dns Resolver minus the C++ channel handle)
// ---------------------------------------------------------------------------

const MAX_TIMEOUT = 2147483647;
const MAX_MAX_TIMEOUT = 4294967295;

function outOfRangeInt(name, value, min, max) {
  // Node's validateInteger: non-integers get 'must be an integer', the rest
  // get the range clause.
  const detail = Number.isInteger(value)
    ? `It must be >= ${min} && <= ${max}. Received ${value}`
    : `It must be an integer. Received ${value}`;
  return coded(
    new RangeError(`The value of "${name}" is out of range. ${detail}`),
    'ERR_OUT_OF_RANGE',
  );
}

function validateResolverOptions(options) {
  if (options == null) return {};
  if (typeof options !== 'object') throw invalidArgType('options', 'of type object', options);
  const out = {};
  if (options.timeout !== undefined) {
    if (typeof options.timeout !== 'number') throw invalidArgType('options.timeout', 'of type number', options.timeout, true);
    if (!Number.isInteger(options.timeout) || options.timeout < -1 || options.timeout > MAX_TIMEOUT) {
      throw outOfRangeInt('options.timeout', options.timeout, -1, MAX_TIMEOUT);
    }
    out.timeout = options.timeout;
  }
  if (options.tries !== undefined) {
    if (typeof options.tries !== 'number') throw invalidArgType('options.tries', 'of type number', options.tries, true);
    if (!Number.isInteger(options.tries) || options.tries < 1 || options.tries > MAX_TIMEOUT) {
      throw outOfRangeInt('options.tries', options.tries, 1, MAX_TIMEOUT);
    }
    out.tries = options.tries;
  }
  if (options.maxTimeout !== undefined) {
    if (typeof options.maxTimeout !== 'number') throw invalidArgType('options.maxTimeout', 'of type number', options.maxTimeout, true);
    if (!Number.isInteger(options.maxTimeout) || options.maxTimeout < 0 || options.maxTimeout > MAX_MAX_TIMEOUT) {
      // Note: real Node's c-ares binding hard-crashes (C++ assertion) for
      // maxTimeout > 4294967295; the shim throws instead of crashing.
      throw outOfRangeInt('options.maxTimeout', options.maxTimeout, 0, MAX_MAX_TIMEOUT);
    }
    out.maxTimeout = options.maxTimeout;
  }
  return out;
}

export class Resolver {
  constructor(options) {
    const opts = validateResolverOptions(options);
    this._servers = DEFAULT_DOH_SERVERS.slice();
    this._timeout = opts.timeout;
    this._tries = opts.tries;
    this._maxTimeout = opts.maxTimeout;
    this._localAddress = undefined;
    this._ac = new AbortController();
    this._pending = 0;
  }

  getServers() {
    return this._servers.slice();
  }

  setServers(servers) {
    const list = validateServerList(servers);
    if (this._pending > 0) throw dnsSetServersFailed(servers);
    this._servers = list;
  }

  setLocalAddress(ipv4, ipv6) {
    // Both arguments accept IPv4 or IPv6 literals (Node validates as IPs);
    // the address is recorded only — a browser has no UDP socket to bind.
    validateString(ipv4, 'ipv4');
    if (ipv6 !== undefined) validateString(ipv6, 'ipv6');
    if (!isIPv4(ipv4) && !isIPv6(ipv4)) {
      throw Object.assign(new TypeError('Invalid IP address.'), { code: 'ERR_INVALID_ARG_VALUE' });
    }
    if (ipv6 !== undefined && !isIPv4(ipv6) && !isIPv6(ipv6)) {
      throw Object.assign(new TypeError('Invalid IP address.'), { code: 'ERR_INVALID_ARG_VALUE' });
    }
    if (ipv6 !== undefined) {
      // Real Node rejects two addresses of the same family.
      if (isIPv4(ipv4) && isIPv4(ipv6)) {
        throw Object.assign(new TypeError('Cannot specify two IPv4 addresses.'), { code: 'ERR_INVALID_ARG_VALUE' });
      }
      if (isIPv6(ipv4) && isIPv6(ipv6)) {
        throw Object.assign(new TypeError('Cannot specify two IPv6 addresses.'), { code: 'ERR_INVALID_ARG_VALUE' });
      }
    }
    this._localAddress = ipv4; // recorded; no UDP socket exists in a browser
  }

  cancel() {
    // Abort in-flight queries; the instance stays usable afterwards.
    const reason = coded(new Error('Query cancelled'), CANCELLED);
    this._ac.abort(reason);
    this._ac = new AbortController();
  }

  _state() {
    return {
      servers: this._servers,
      resultOrder: defaultResultOrder,
      timeout: this._timeout,
      signal: this._ac.signal,
    };
  }

  _resolveWith(type, hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    validateString(hostname, 'name');
    validateFunction(callback, 'callback');
    const wantTtl = (type === 'A' || type === 'AAAA') && !!(options && typeof options === 'object' && options.ttl);
    const state = this._state();
    const signal = state.signal;
    asyncTracked(this, callback, async (done) => {
      if (signal.aborted) {
        done(dnsError(SYSCALL_FOR_TYPE[type], CANCELLED, hostname));
        return;
      }
      try {
        const { records, ttls } = await resolveImpl(state, hostname, type);
        const shaped = type === 'SOA' ? records[0]
          : wantTtl ? records.map((address, i) => ({ address, ttl: ttls[i] }))
          : records;
        done(null, shaped);
      } catch (e) {
        done(e);
      }
    });
  }

  resolve4(hostname, options, callback) { this._resolveWith('A', hostname, options, callback); }
  resolve6(hostname, options, callback) { this._resolveWith('AAAA', hostname, options, callback); }
  resolveCname(hostname, callback) { this._resolveWith('CNAME', hostname, callback); }
  resolveMx(hostname, callback) { this._resolveWith('MX', hostname, callback); }
  resolveNs(hostname, callback) { this._resolveWith('NS', hostname, callback); }
  resolveTxt(hostname, callback) { this._resolveWith('TXT', hostname, callback); }
  resolveSrv(hostname, callback) { this._resolveWith('SRV', hostname, callback); }
  resolveSoa(hostname, callback) { this._resolveWith('SOA', hostname, callback); }
  resolvePtr(hostname, callback) { this._resolveWith('PTR', hostname, callback); }
  resolveNaptr(hostname, callback) { this._resolveWith('NAPTR', hostname, callback); }
  resolveCaa(hostname, callback) { this._resolveWith('CAA', hostname, callback); }
  resolveTlsa(hostname, callback) { this._resolveWith('TLSA', hostname, callback); }

  resolve(hostname, rrtype, callback) {
    if (typeof rrtype === 'function') { callback = rrtype; rrtype = 'A'; }
    validateString(hostname, 'name');
    if (rrtype === undefined) rrtype = 'A';
    if (typeof rrtype !== 'string') throw invalidArgType('rrtype', 'of type string', rrtype);
    if (!VALID_RRTYPES.includes(rrtype)) {
      throw coded(
        new TypeError(`The argument 'rrtype' is invalid. Received '${rrtype}'`),
        'ERR_INVALID_ARG_VALUE',
      );
    }
    validateFunction(callback, 'callback');
    if (rrtype === 'ANY') {
      asyncCallback(callback, () => callback(dnsError('queryAny', NOTIMP, hostname)));
      return;
    }
    const method = {
      A: 'resolve4', AAAA: 'resolve6', CNAME: 'resolveCname', MX: 'resolveMx',
      NS: 'resolveNs', TXT: 'resolveTxt', SRV: 'resolveSrv', SOA: 'resolveSoa',
      PTR: 'resolvePtr', NAPTR: 'resolveNaptr', CAA: 'resolveCaa', TLSA: 'resolveTlsa',
    }[rrtype];
    this[method](hostname, callback);
  }

  resolveAny(hostname, callback) {
    validateString(hostname, 'name');
    validateFunction(callback, 'callback');
    asyncCallback(callback, () => callback(dnsError('queryAny', NOTIMP, hostname)));
  }

  reverse(ip, callback) {
    validateString(ip, 'ip');
    if (!isIPv4(ip) && !isIPv6(ip)) throw dnsError('getHostByAddr', 'EINVAL', ip);
    validateFunction(callback, 'callback');
    const state = this._state();
    asyncTracked(this, callback, async (done) => {
      try {
        const { records: hostnames } = await resolveImpl(state, ipToArpa(ip), 'PTR');
        done(null, hostnames);
      } catch (e) {
        if (e && e.syscall === 'queryPtr') done(dnsError('getHostByAddr', e.code, ip));
        else done(e);
      }
    });
  }
}

// The promises namespace lives in ./dns/promises.js. Importing its module
// namespace here (and exposing it as `promises`) keeps
// require('dns/promises') === require('dns').promises under the parity
// preload, exactly like real Node. The import is cycle-safe: promises.js
// never evaluates these bindings at module top level.
import * as _promisesNs from './dns/promises.js';
export const promises = _promisesNs;

// Promises-flavoured Resolver (mirrors the distinct subclass that
// node:dns/promises exports): same configuration surface as the callback
// Resolver, but every query method returns a promise. Defined here so the
// extends clause never touches a cross-module binding at evaluation time.
export class PromisesResolver extends Resolver {
  _asPromise(method, ...args) {
    return new Promise((resolvePromise, reject) => {
      method(...args, (err, result) => (err ? reject(err) : resolvePromise(result)));
    });
  }

  resolve(hostname, rrtype) {
    return this._asPromise(super.resolve.bind(this), hostname, rrtype);
  }
  resolve4(hostname, options) {
    return this._asPromise(super.resolve4.bind(this), hostname, options);
  }
  resolve6(hostname, options) {
    return this._asPromise(super.resolve6.bind(this), hostname, options);
  }
  resolveAny(hostname) {
    return this._asPromise(super.resolveAny.bind(this), hostname);
  }
  resolveCaa(hostname) {
    return this._asPromise(super.resolveCaa.bind(this), hostname);
  }
  resolveCname(hostname) {
    return this._asPromise(super.resolveCname.bind(this), hostname);
  }
  resolveMx(hostname) {
    return this._asPromise(super.resolveMx.bind(this), hostname);
  }
  resolveNaptr(hostname) {
    return this._asPromise(super.resolveNaptr.bind(this), hostname);
  }
  resolveNs(hostname) {
    return this._asPromise(super.resolveNs.bind(this), hostname);
  }
  resolvePtr(hostname) {
    return this._asPromise(super.resolvePtr.bind(this), hostname);
  }
  resolveSoa(hostname) {
    return this._asPromise(super.resolveSoa.bind(this), hostname);
  }
  resolveSrv(hostname) {
    return this._asPromise(super.resolveSrv.bind(this), hostname);
  }
  resolveTlsa(hostname) {
    return this._asPromise(super.resolveTlsa.bind(this), hostname);
  }
  resolveTxt(hostname) {
    return this._asPromise(super.resolveTxt.bind(this), hostname);
  }
  reverse(ip) {
    return this._asPromise(super.reverse.bind(this), ip);
  }
}

export default {
  lookup,
  lookupService,
  resolve,
  resolve4,
  resolve6,
  resolveAny,
  resolveCaa,
  resolveCname,
  resolveMx,
  resolveNaptr,
  resolveNs,
  resolvePtr,
  resolveSoa,
  resolveSrv,
  resolveTlsa,
  resolveTxt,
  reverse,
  Resolver,
  getServers,
  setServers,
  getDefaultResultOrder,
  setDefaultResultOrder,
  promises,
  NODATA, FORMERR, SERVFAIL, NOTFOUND, NOTIMP, REFUSED, BADQUERY,
  BADNAME, BADFAMILY, BADRESP, CONNREFUSED, TIMEOUT, EOF, FILE, NOMEM,
  DESTRUCTION, BADSTR, BADFLAGS, NONAME, BADHINTS, NOTINITIALIZED,
  LOADIPHLPAPI, ADDRGETNETWORKPARAMS, CANCELLED,
  ADDRCONFIG, V4MAPPED, ALL,
};
