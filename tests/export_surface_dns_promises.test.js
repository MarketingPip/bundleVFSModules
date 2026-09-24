// Export-surface parity: src/dns/promises.js  <->  node:dns/promises
// captured from real Node v24.20.0 (node:dns/promises)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/dns/promises.js';

const EXPECTED = ["ADDRGETNETWORKPARAMS","BADFAMILY","BADFLAGS","BADHINTS","BADNAME","BADQUERY","BADRESP","BADSTR","CANCELLED","CONNREFUSED","DESTRUCTION","EOF","FILE","FORMERR","LOADIPHLPAPI","NODATA","NOMEM","NONAME","NOTFOUND","NOTIMP","NOTINITIALIZED","REFUSED","Resolver","SERVFAIL","TIMEOUT","default","getDefaultResultOrder","getServers","lookup","lookupService","resolve","resolve4","resolve6","resolveAny","resolveCaa","resolveCname","resolveMx","resolveNaptr","resolveNs","resolvePtr","resolveSoa","resolveSrv","resolveTlsa","resolveTxt","reverse","setDefaultResultOrder","setServers"];

test('node:dns/promises export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
