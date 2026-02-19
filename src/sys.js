 import util from 'util';

'use strict';

// The sys module was renamed to 'util'. This shim remains to keep old programs
 
if(globalThis && globalThis?.process){
process?.emitWarning('sys is deprecated. Use `node:util` instead.',
                    'DeprecationWarning', 'DEP0025');
}
 
export default util; 
