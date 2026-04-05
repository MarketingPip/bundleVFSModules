import process from './process.js';
import Buffer from './buffer.js';
import {clearImmediate, setImmediate} from './timers.js';
globalThis.process = process;
globalThis.Buffer = Buffer;
globalThis.clearImmediate = clearImmediate;
globalThis.setImmediate = setImmediate;
 
