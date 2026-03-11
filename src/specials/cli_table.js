'use strict';

import cTable from "https://esm.sh/console.table";

// save original
const originalConsoleTable = globalThis.console.table;

// patched implementation
function patchedConsoleTable(...args) {
  for (const arg of args) {
    const table = cTable.getTable(arg);
    originalConsoleTable.call(console, table);
  }
}

// make it look native
patchedConsoleTable.toString = () => "function table() { [native code] }";

// replace
globalThis.console.table = patchedConsoleTable;
