// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
function getTestReporters(argv) {
  const reporters = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--test-reporter') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        reporters.push(...next.split(','));
        i++;
      }
    } else if (arg.startsWith('--test-reporter=')) {
      const value = arg.split('=').slice(1).join('=');
      reporters.push(...value.split(','));
    }
  }

  if(reporters.filter(Boolean).length === 0){
    return ['spec'];
  }

  return reporters.filter(Boolean);
}

 

   
 
       const _REPORTERS = getTestReporters(process.argv)
       for (const REPORTER in _REPORTERS){

       if(_REPORTERS[REPORTER] === "lcov"){
         // TODO: inject a coverage event into events somehow.
         throw new Error("lcov is not implemented")
       };
       const testRunner = await globalThis[_BVM_RT_KEY_]._TEST_RUNNER_.execute(`
       
       
       __IMPORTS__
       //__$PROVIDED_RUNTIME_CODE__/
       
       __USER_CODE__
       
       
       
       `, {reporter:_REPORTERS[REPORTER]});
       
       console.log(testRunner.output)
       
       }
       
       
       
       
         
      // console.log(globalThis._RUNTIME_TEST_RUNNER_.tap(testRunner));
       }catch(err){
         err.stack = err.message;
         throw err
       }
       
} else {
await (async () => {
//__$PROVIDED_RUNTIME_CODE__/
__USER_CODE__
})();

}
  
     
   
    // await tracker.waitForCompletion();
   
       
    