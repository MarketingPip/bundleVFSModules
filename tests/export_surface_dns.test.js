// Export-surface parity: src/dns.js  <->  node:dns
// captured from real Node v24.20.0 (node:dns)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/dns.js';

const EXPECTED = ["ADDRCONFIG","ADDRGETNETWORKPARAMS","ALL","BADFAMILY","BADFLAGS","BADHINTS","BADNAME","BADQUERY","BADRESP","BADSTR","CANCELLED","CONNREFUSED","DESTRUCTION","EOF","FILE","FORMERR","LOADIPHLPAPI","NODATA","NOMEM","NONAME","NOTFOUND","NOTIMP","NOTINITIALIZED","REFUSED","Resolver","SERVFAIL","TIMEOUT","V4MAPPED","default","getDefaultResultOrder","getServers","lookup","lookupService","promises","resolve","resolve4","resolve6","resolveAny","resolveCaa","resolveCname","resolveMx","resolveNaptr","resolveNs","resolvePtr","resolveSoa","resolveSrv","resolveTlsa","resolveTxt","reverse","setDefaultResultOrder","setServers"];

test('node:dns export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
