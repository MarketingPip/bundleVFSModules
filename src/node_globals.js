import stdin from './internals/stdin.js';
import makeShim from './internals/stdout.js';
import {patchConsoleTable} from './internals/cli_table.js';

patchConsoleTable(); // turns JSON to proper table
globalThis.process.stdin = stdin;
globalThis.process.stdout = makeShim('stdout');
