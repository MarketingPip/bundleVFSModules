import stdin from './internals/stdin.js';
import './internals/cli_table.js';
import makeShim from './internals/stdout.js';
globalThis.process.stdin = stdin;
globalThis.process.stdout = makeShim('stdout');
