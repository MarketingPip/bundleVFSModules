// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// --- Key Decoder Function ---
  function decodeKeyPress(str) {
    if (!str) return null;

    // ANSI Escape sequences for arrow keys
    if (str === '\x1b[A' || str === '\x1bOA') return { name: 'up', sequence: str };
    if (str === '\x1b[B' || str === '\x1bOB') return { name: 'down', sequence: str };
    if (str === '\x1b[C' || str === '\x1bOC') return { name: 'right', sequence: str };
    if (str === '\x1b[D' || str === '\x1bOD') return { name: 'left', sequence: str };

    // Enter / Return keys
    if (str === '\r' || str === '\n') return { name: 'return', sequence: str };

    // Backspace
    if (str === '\x7f' || str === '\b') return { name: 'backspace', sequence: str };

    // Handle single characters & Ctrl combinations
    if (str.length === 1) {
      const code = str.charCodeAt(0);
      // Check for Ctrl+A through Ctrl+Z (ASCII codes 1 to 26)
      if (code >= 1 && code <= 26) {
        return {
          name: String.fromCharCode(code + 96),
          ctrl: true,
          sequence: str
        };
      }
      return { name: str, sequence: str };
    }

    // Fallback for complex/unrecognized sequences
    return { name: 'unknown', sequence: str };
  }
  
  function stripKeySequencesPreserveWhitespace(str) {
  if (!str) return "";

  return str
    // Remove ANSI escape sequences (arrow keys, function keys, CSI sequences)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b[\(\)][0-9A-Za-z]/g, '')
    // Remove control characters except \n (\x0A) and \t (\x09)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}
  // TODO: handle if buffered pass or possible remove if emulating node?
    try {   
              const cleanedCode = stripKeySequencesPreserveWhitespace(args);
              
               const keyEvent = decodeKeyPress(args);
              if (keyEvent) {
                // emitMe("key_event", null, keyEvent)
                return;  
              }
              
               if(!cleanedCode){
                return; 
               }
                const E = window.eval(cleanedCode);
                console.log(E)
            } catch (E) {
                return void console.error(E.message)
            }
});

 

globalThis.__INTEROP_VAR__.expose('__serverRequest__', async (port=8080, URL = "/", type = "GET", body= {}, headers = {}) => {
    const __RT = globalThis[_BVM_RT_KEY_];
    // Normalize the legacy arg order (port, method, url, headers, body) to the
    // canonical (port, url, method, body, headers) BEFORE any cookie logic,
    // mirroring handleRequest's normalization in src/http.js. Without this the
    // jar would key/store cookies under the wrong path/method.
    let __url = URL, __method = type, __body = body, __headers = headers;
    if (typeof URL === 'string' && /^[A-Z]+$/.test(URL) &&
        typeof type === 'string' && type.startsWith('/')) {
      __method = URL;
      __url = type;
      __headers = body;
      __body = headers;
    }
    URL = __url; type = __method; body = __body; headers = __headers;
    const __h = { ...(headers || {}) };
    let __jarCtx = null;
    