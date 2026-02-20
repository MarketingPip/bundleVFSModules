import dnsPacket from 'dns-packet';
import base32Encode from 'base32-encode';

/**
 * Allowed request methods for DoH
 */
const ALLOWED_REQUEST_METHODS = ["GET", "POST"];

class MethodNotAllowedError extends Error {
  constructor(message = "") {
    super(message);
    this.name = 'MethodNotAllowedError';
  }
}

function isMethodAllowed(method) {
  return ALLOWED_REQUEST_METHODS.includes(method);
}

/**
 * Browser-friendly DNS-over-HTTPS resolver
 */
class DohResolver {
  constructor(nameserver_url) {
    this.nameserver_url = nameserver_url;
  }

  query(qname, qtype = 'A', method = 'POST', headers = {}, timeout = 5000) {
    if (!isMethodAllowed(method)) {
      return Promise.reject(new MethodNotAllowedError(
        `Request method ${method} not allowed. Must be 'GET' or 'POST'`
      ));
    }

    const packet = makeQuery(qname, qtype);
    return sendDohMsg(packet, this.nameserver_url, method, headers, timeout);
  }
}

/**
 * Create DNS query packet
 */
function makeQuery(qname, qtype = 'A') {
  return {
    type: 'query',
    id: 0,
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ type: qtype, name: qname }]
  };
}

/**
 * Browser-compatible DoH sender using fetch()
 */
function sendDohMsg(packet, url, method = 'POST', headers = {}, timeout = 5000) {
  const buf = dnsPacket.encode(packet);

  if (!headers['Accept']) headers['Accept'] = 'application/dns-message';
  if (!headers['User-Agent']) headers['User-Agent'] = 'dohjs/0.2.0';

  let fetchOptions = { method, headers };

  if (method === 'POST') {
    headers['Content-Type'] = 'application/dns-message';
    fetchOptions.body = buf;
  } else if (method === 'GET') {
    const dnsQueryParam = buf.toString('base64').replace(/=/g, '');
    url += `?dns=${dnsQueryParam}`;
  }

  const controller = new AbortController();
  fetchOptions.signal = controller.signal;
  const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null;

  return fetch(url, fetchOptions)
    .then(res => res.arrayBuffer())
    .then(arrayBuffer => {
      if (timer) clearTimeout(timer);
      return dnsPacket.decode(Buffer.from(arrayBuffer));
    });
}

/**
 * Convert DNS packets to human-readable format
 */
function prettify(msg) {
  for (const rr of (msg.answer || []).concat(msg.authorities || [])) {
    if (rr.data) {
      switch (rr.type) {
        case 'TXT': rr.data = rr.data.toString('utf8'); break;
        case 'DNSKEY': rr.data.key = rr.data.key.toString('base64').replace(/=/g, ''); break;
        case 'DS': rr.data.digest = rr.data.digest.toString('hex'); break;
        case 'NSEC3':
          rr.data.salt = rr.data.salt.toString('hex');
          rr.data.nextDomain = base32Encode(rr.data.nextDomain, 'RFC4648-HEX').replace(/=/g, '');
          break;
        case 'RRSIG': rr.data.signature = rr.data.signature.toString('base64').replace(/=/g, ''); break;
      }
    }
  }
  return msg;
}

// Exported API
const dohjs = {
  DohResolver,
  makeQuery,
  sendDohMsg,
  prettify,
  MethodNotAllowedError,
  isMethodAllowed,
  dnsPacket
};


// END OF DOH-JS

const doh = dohjs;

// Configuration
const CLOUDFLARE_DOH = "https://cloudflare-dns.com/dns-query"
const resolver = new doh.DohResolver(CLOUDFLARE_DOH)

// Helper to simulate Node's setImmediate in the browser
const defer = fn => setTimeout(fn, 0)

/**
 * Real-ish Lookup using DoH
 */
export function lookup(hostname, optionsOrCallback, callback) {
  const cb = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
  const options = typeof optionsOrCallback === "object" ? optionsOrCallback : {};

  // Handle localhost instantly
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    defer(() => {
      if (options.all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
      else cb(null, "127.0.0.1", 4);
    });
    return;
  }

  resolver
    .query(hostname, "A")
    .then(response => {
      // Ensure answer exists and is an array
      return cb(response);
      const answers = (response.answer || []).filter(a => a.type === "A");

      if (answers.length === 0) {
        return cb(new Error(`ENOTFOUND ${hostname}`));
      }

      if (options.all) {
        const results = answers.map(a => ({ address: a.data, family: 4 }));
        cb(null, results);
      } else {
        cb(null, answers[0].data, 4);
      }
    })
    .catch(err => cb(err));
}

/**
 * Resolve hostname - returns array of strings
 */
export function resolve4(hostname, callback) {
  resolver
    .query(hostname, "A")
    .then(response => {
      const ips = (response.answer || []).filter(a => a.type === "A").map(a => a.data);
      callback(null, ips);
    })
    .catch(err => callback(err));
}

export function resolve6(hostname, callback) {
  resolver
    .query(hostname, "AAAA")
    .then(response => {
      const ips = (response.answer || []).filter(a => a.type === "AAAA").map(a => a.data);
      callback(null, ips);
    })
    .catch(err => callback(err));
}

// Map general resolve to resolve4 for simplicity
export const resolve = resolve4

/**
 * Promises API Implementation
 */
export const promises = {
  lookup: (hostname, options) => {
    return new Promise((res, rej) => {
      lookup(hostname, options || {}, (err, address, family) => {
        if (err) rej(err)
        else res(options?.all ? address : { address, family })
      })
    })
  },
  resolve4: hostname => {
    return new Promise((res, rej) => {
      resolve4(hostname, (err, addresses) => (err ? rej(err) : res(addresses)))
    })
  },
  resolve6: hostname => {
    return new Promise((res, rej) => {
      resolve6(hostname, (err, addresses) => (err ? rej(err) : res(addresses)))
    })
  }
}

// ... keep your existing stubs for reverse, setServers, etc.
export default { lookup, resolve, resolve4, resolve6, promises }
