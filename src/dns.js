import doh from 'dohjs';

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
