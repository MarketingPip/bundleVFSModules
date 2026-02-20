import doh from "dohjs"

// Configuration 
const CLOUDFLARE_DOH = "https://cloudflare-dns.com/dns-query";
const resolver = new doh.DohResolver(CLOUDFLARE_DOH);

// Always async like Node
const defer = fn => setTimeout(fn, 0);

 
// Normalize hostname
function normalizeHostname(hostname) {
  if (typeof hostname !== "string" || hostname.length === 0) {
    const err = new Error("Invalid hostname");
    err.code = "EINVAL";
    throw err;
  }
  try {
    if (hostname.includes("://")) hostname = new URL(hostname).hostname;
  } catch {}
  return hostname;
}

/**
 * setServers / getServers emulation
 */
export function setServers(servers) {
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new Error("setServers requires a non-empty array of DoH URLs");
  }
  dohServers = servers.slice();
  resolver = new doh.DohResolver(dohServers[0]);
}
export function getServers() {
  return dohServers.slice();
}

/**
 * lookup(hostname, options?, callback)
 */
export function lookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  options = options || {};
  let family = options.family || 0;
  const all = !!options.all;

  try {
    hostname = normalizeHostname(hostname);
  } catch (err) {
    return defer(() => callback(err));
  }

  const queries = [];
  if (family === 4) queries.push(resolver.query(hostname, "A"));
  else if (family === 6) queries.push(resolver.query(hostname, "AAAA"));
  else {
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
          .map(r => ({ address: r.data, family: type === "A" ? 4 : 6 }));
        records.push(...found);
      });

      if (!records.length) {
        const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        err.code = "ENOTFOUND";
        return defer(() => callback(err));
      }

      if (all) return defer(() => callback(null, records));
      defer(() => callback(null, records[0].address, records[0].family));
    })
    .catch(err => defer(() => callback(err)));
}

/**
 * resolve4 / resolve6
 */
export function resolve4(hostname, callback) {
  try { hostname = normalizeHostname(hostname); } catch(err) { return defer(() => callback(err)); }
  resolver.query(hostname, "A").then(res => {
    const ips = (res.answers || []).filter(r => r.type === "A").map(r => r.data);
    if (!ips.length) return defer(() => callback(Object.assign(new Error(`queryA ENOTFOUND ${hostname}`), { code: "ENOTFOUND" })));
    defer(() => callback(null, ips));
  }).catch(err => defer(() => callback(err)));
}

export function resolve6(hostname, callback) {
  try { hostname = normalizeHostname(hostname); } catch(err) { return defer(() => callback(err)); }
  resolver.query(hostname, "AAAA").then(res => {
    const ips = (res.answers || []).filter(r => r.type === "AAAA").map(r => r.data);
    if (!ips.length) return defer(() => callback(Object.assign(new Error(`queryAAAA ENOTFOUND ${hostname}`), { code: "ENOTFOUND" })));
    defer(() => callback(null, ips));
  }).catch(err => defer(() => callback(err)));
}

// alias general resolve
export const resolve = resolve4;

/**
 * resolveMx
 */
export function resolveMx(hostname, callback) {
  try { hostname = normalizeHostname(hostname); } catch(err) { return defer(() => callback(err)); }
  resolver.query(hostname, "MX").then(res => {
    const records = (res.answers || []).filter(r => r.type === "MX").map(r => ({
      priority: r.data.preference,
      exchange: r.data.exchange
    }));
    if (!records.length) return defer(() => callback(Object.assign(new Error(`queryMX ENOTFOUND ${hostname}`), { code: "ENOTFOUND" })));
    defer(() => callback(null, records));
  }).catch(err => defer(() => callback(err)));
}

/**
 * resolveNs
 */
export function resolveNs(hostname, callback) {
  try { hostname = normalizeHostname(hostname); } catch(err) { return defer(() => callback(err)); }
  resolver.query(hostname, "NS").then(res => {
    const records = (res.answers || []).filter(r => r.type === "NS").map(r => r.data);
    if (!records.length) return defer(() => callback(Object.assign(new Error(`queryNS ENOTFOUND ${hostname}`), { code: "ENOTFOUND" })));
    defer(() => callback(null, records));
  }).catch(err => defer(() => callback(err)));
}

/**
 * resolveCname
 */
export function resolveCname(hostname, callback) {
  try { hostname = normalizeHostname(hostname); } catch(err) { return defer(() => callback(err)); }
  resolver.query(hostname, "CNAME").then(res => {
    const records = (res.answers || []).filter(r => r.type === "CNAME").map(r => r.data);
    if (!records.length) return defer(() => callback(Object.assign(new Error(`queryCNAME ENOTFOUND ${hostname}`), { code: "ENOTFOUND" })));
    defer(() => callback(null, records));
  }).catch(err => defer(() => callback(err)));
}

/**
 * resolveTxt
 */
export function resolveTxt(hostname, callback) {
  try { hostname = normalizeHostname(hostname); } catch(err) { return defer(() => callback(err)); }
  resolver.query(hostname, "TXT").then(res => {
    const records = (res.answers || [])
      .filter(r => r.type === "TXT")
      .map(r => Array.isArray(r.data) ? r.data : [r.data.toString()]);
    if (!records.length) return defer(() => callback(Object.assign(new Error(`queryTXT ENOTFOUND ${hostname}`), { code: "ENOTFOUND" })));
    defer(() => callback(null, records));
  }).catch(err => defer(() => callback(err)));
}

/**
 * resolveSrv
 */
export function resolveSrv(hostname, callback) {
  try { hostname = normalizeHostname(hostname); } catch(err) { return defer(() => callback(err)); }
  resolver.query(hostname, "SRV").then(res => {
    const records = (res.answers || []).filter(r => r.type === "SRV").map(r => ({
      priority: r.data.priority,
      weight: r.data.weight,
      port: r.data.port,
      name: r.data.target
    }));
    if (!records.length) return defer(() => callback(Object.assign(new Error(`querySRV ENOTFOUND ${hostname}`), { code: "ENOTFOUND" })));
    defer(() => callback(null, records));
  }).catch(err => defer(() => callback(err)));
}

/**
 * resolveSoa
 */
export function resolveSoa(hostname, callback) {
  try { hostname = normalizeHostname(hostname); } catch(err) { return defer(() => callback(err)); }
  resolver.query(hostname, "SOA").then(res => {
    const rec = (res.answers || []).find(r => r.type === "SOA");
    if (!rec) return defer(() => callback(Object.assign(new Error(`querySOA ENOTFOUND ${hostname}`), { code: "ENOTFOUND" })));
    const r = {
      nsname: rec.data.nsname,
      hostmaster: rec.data.hostmaster,
      serial: rec.data.serial,
      refresh: rec.data.refresh,
      retry: rec.data.retry,
      expire: rec.data.expire,
      minimum: rec.data.minimum
    };
    defer(() => callback(null, r));
  }).catch(err => defer(() => callback(err)));
}

/**
 * Promises API
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
  resolve4(hostname) { return new Promise((res, rej) => resolve4(hostname, (e, a) => e ? rej(e) : res(a))); },
  resolve6(hostname) { return new Promise((res, rej) => resolve6(hostname, (e, a) => e ? rej(e) : res(a))); },
  resolveMx(hostname) { return new Promise((res, rej) => resolveMx(hostname, (e, a) => e ? rej(e) : res(a))); },
  resolveNs(hostname) { return new Promise((res, rej) => resolveNs(hostname, (e, a) => e ? rej(e) : res(a))); },
  resolveCname(hostname) { return new Promise((res, rej) => resolveCname(hostname, (e, a) => e ? rej(e) : res(a))); },
  resolveTxt(hostname) { return new Promise((res, rej) => resolveTxt(hostname, (e, a) => e ? rej(e) : res(a))); },
  resolveSrv(hostname) { return new Promise((res, rej) => resolveSrv(hostname, (e, a) => e ? rej(e) : res(a))); },
  resolveSoa(hostname) { return new Promise((res, rej) => resolveSoa(hostname, (e, a) => e ? rej(e) : res(a))); },
};

export default {
  lookup,
  resolve,
  resolve4,
  resolve6,
  resolveMx,
  resolveNs,
  resolveCname,
  resolveTxt,
  resolveSrv,
  resolveSoa,
  setServers,
  getServers,
  promises
};
