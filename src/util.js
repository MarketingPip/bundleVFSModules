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


// ANSI color and style codes mapping
const ansiCodes = {
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  blink: [5, 25],
  inverse: [7, 27],
  hidden: [8, 28],
  strikethrough: [9, 29],
  black: [30, 39],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  white: [37, 39],
  gray: [90, 39],
  bgBlack: [40, 49],
  bgRed: [41, 49],
  bgGreen: [42, 49],
  bgYellow: [43, 49],
  bgBlue: [44, 49],
  bgMagenta: [45, 49],
  bgCyan: [46, 49],
  bgWhite: [47, 49]
};

// Polyfill definition
export function styleText(format, text) {
  if (typeof text !== 'string') {
    throw new TypeError('The "text" argument must be of type string.');
  }

  // Check if process/stdout supports color (optional safeguard)
  const hasColor = typeof process !== 'undefined' && 
    process.stdout && 
    process.stdout.hasColors && 
    !process.stdout.hasColors();

  if (hasColor) return text;

  const formats = Array.isArray(format) ? format : [format];
  let openCode = '';
  let closeCode = '';

  for (const fmt of formats) {
    const codes = ansiCodes[fmt];
    if (!codes) {
      throw new Error(`Invalid format style: ${fmt}`);
    }
    openCode += `\u001b[${codes[0]}m`;
    closeCode = `\u001b[${codes[1]}m` + closeCode;
  }

  return `${openCode}${text}${closeCode}`;
}


// Export the namespace as default
// export default util;
