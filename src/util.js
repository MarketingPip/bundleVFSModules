import util from "util"
'use strict';

// The sys module was renamed to 'util'. This shim remains to keep old programs
 
 /*
TODO implement emitWarning: https://github.com/nodejs/node/blob/9cc7fcc26dece769d9ffa06c453f0171311b01f8/lib/internal/process/warning.js#L138 
 
process.emitWarning('sys is deprecated. Use `node:util` instead.',
                    'DeprecationWarning', 'DEP0025');
 */                    
export default util
