// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// Full path to the current file (commonJS)
/*
globalThis.__filename = "";

// Directory of the current file
globalThis.__dirname = "";
*/



   // Track pending module imports
const pendingModules = new Map();

 
function waitForAllModules() {
  return new Promise(resolve => {
    const check = () => {
      if (pendingModules.size === 0) {
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}



    


const startTime = performance.now();



