// Configuration
const CLOUDFLARE_DOH = "https://cloudflare-dns.com/dns-query";
const resolver = new doh.DohResolver(CLOUDFLARE_DOH);

// Always async like Node
const defer = fn => setTimeout(fn, 0);

// Normalize hostname (accept URL input)
function normalizeHostname(hostname) {
  if (typeof hostname !== "string" || hostname.length === 0) {
    const err = new Error("Invalid hostname");
    err.code = "EINVAL";
    throw err;
  }

  try {
    if (hostname.includes("://")) {
      hostname = new URL(hostname).hostname;
    }
  } catch {}

  return hostname;
}

/**
 * dns.lookup (Node-realistic behavior)
 */
export function lookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }

  options = options || {};

  try {
    hostname = normalizeHostname(hostname);
  } catch (err) {
    return defer(() => callback(err));
  }

  const family = options.family || 0; // 0 = auto
  const wantAll = !!options.all;

  const queries = [];

  if (family === 4) queries.push(resolver.query(hostname, "A"));
  else if (family === 6) queries.push(resolver.query(hostname, "AAAA"));
  else {
    // family 0 → try A first (Node prefers IPv4 by default)
    queries.push(resolver.query(hostname, "A"));
    queries.push(resolver.query(hostname, "AAAA"));
  }

  Promise.allSettled(queries)
    .then(results => {
      let records = [];

      results.forEach((res, index) => {
        if (res.status !== "fulfilled") return;

        const type =
          family === 4 ? "A" :
          family === 6 ? "AAAA" :
          index === 0 ? "A" : "AAAA";

        const found = (res.value.answers || [])
          .filter(r => r.type === type)
          .map(r => ({
            address: r.data,
            family: type === "A" ? 4 : 6
          }));

        records.push(...found);
      });

      if (records.length === 0) {
        const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        err.code = "ENOTFOUND";
        return defer(() => callback(err));
      }

      if (wantAll) {
        return defer(() => callback(null, records));
      }

      const first = records[0];
      defer(() => callback(null, first.address, first.family));
    })
    .catch(err => defer(() => callback(err)));
}

/**
 * dns.resolve4
 */
export function resolve4(hostname, callback) {
  try {
    hostname = normalizeHostname(hostname);
  } catch (err) {
    return defer(() => callback(err));
  }

  resolver.query(hostname, "A")
    .then(res => {
      const ips = (res.answers || [])
        .filter(r => r.type === "A")
        .map(r => r.data);

      if (ips.length === 0) {
        const err = new Error(`queryA ENOTFOUND ${hostname}`);
        err.code = "ENOTFOUND";
        return defer(() => callback(err));
      }

      defer(() => callback(null, ips));
    })
    .catch(err => defer(() => callback(err)));
}

/**
 * dns.resolve6
 */
export function resolve6(hostname, callback) {
  try {
    hostname = normalizeHostname(hostname);
  } catch (err) {
    return defer(() => callback(err));
  }

  resolver.query(hostname, "AAAA")
    .then(res => {
      const ips = (res.answers || [])
        .filter(r => r.type === "AAAA")
        .map(r => r.data);

      if (ips.length === 0) {
        const err = new Error(`queryAAAA ENOTFOUND ${hostname}`);
        err.code = "ENOTFOUND";
        return defer(() => callback(err));
      }

      defer(() => callback(null, ips));
    })
    .catch(err => defer(() => callback(err)));
}

export const resolve = resolve4;

/**
 * Promises API (Node compatible shape)
 */
export const promises = {
  lookup(hostname, options = {}) {
    return new Promise((resolve, reject) => {
      lookup(hostname, options, (err, address, family) => {
        if (err) return reject(err);

        if (options.all) return resolve(address);

        resolve({ address, family });
      });
    });
  },

  resolve4(hostname) {
    return new Promise((resolve, reject) => {
      resolve4(hostname, (err, addresses) =>
        err ? reject(err) : resolve(addresses)
      );
    });
  },

  resolve6(hostname) {
    return new Promise((resolve, reject) => {
      resolve6(hostname, (err, addresses) =>
        err ? reject(err) : resolve(addresses)
      );
    });
  }
};

export default {
  lookup,
  resolve,
  resolve4,
  resolve6,
  promises
};
