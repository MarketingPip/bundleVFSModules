import stdin from './internals/stdin.js';
import makeShim from './internals/stdout.js';
globalThis.process.stdin = stdin;
globalThis.process.stdout = makeShim('stdout');
