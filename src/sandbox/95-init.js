// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// Remove these when emulating Node.js true behaviour
// let document = undefined;
// let location = undefined; 
 
    
  "__TEST_IMPORTS__";
  
  
 // globalThis.window =  _window;
  // globalThis.document =  _document;




 
  for (const [name, fn] of [
  ['setTimeout',    setTimeout],
  ['clearTimeout',  clearTimeout],
  ['setInterval',   setInterval],
  ['clearInterval', clearInterval],
]) {
  Object.defineProperty(globalThis, name, {
    get: () => fn,
    set: () => {},       // silently swallow user writes
    configurable: false,
    enumerable: true,
  });
}
      
     
 
   
      // const tracker = new AsyncOperationTracker();
    /* TODO: add flags for --test-reporter=spec mytest.js (json, dot, spec - exists) or if in env.NODE_TEST_REPORTER
     node --test file.js 
    node --test (run all test files in VFS)
    */ 
 if ("__ARGV_HAS_TEST__") {

    
     let _testRunner;
     
      try{ 
      
      if(!globalThis[_BVM_RT_KEY_]._TEST_RUNNER_){
       await globalThis[_BVM_RT_KEY_].loadModule("node:test")
       }
      // globalThis._RUNTIME_TEST_RUNNER_.REPORTER_TYPE = 'tap';
       // console.log(globalThis._RUNTIME_TEST_RUNNER_._activeReporter)
     
       // const reporter = process.argv.find(arg => arg.startsWith('--test-reporter='))?.split('=')[1];
       
       