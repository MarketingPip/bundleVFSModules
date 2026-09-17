'use strict';

// Import all named exports as a namespace
import * as util from 'util';

// Export everything as named exports
export * from 'util';

// 1. Define the Regex that matches ANSI Escape sequences / VT Control Characters
const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripVTControlCharacters(str) {
  if (typeof str !== 'string') {
    throw new TypeError(`The "str" argument must be of type string. Received type ${typeof str}`);
  }
  return str.replace(ansiRegex, '');
}

 
export { stripVTControlCharacters };

// Export the namespace as default
// export default util;
