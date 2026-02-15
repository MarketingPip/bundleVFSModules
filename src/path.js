import util from "util"
'use strict';

// The sys module was renamed to 'util'. This shim remains to keep old programs
// working. `sys` is deprecated and shouldn't be used.

// Note to maintainers: Although this module has been deprecated for a while
// we do not plan to remove it. See: https://github.com/nodejs/node/pull/35407#issuecomment-700693439
 
process.emitWarning('sys is deprecated. Use `node:util` instead.',
                    'DeprecationWarning', 'DEP0025');
export default util
