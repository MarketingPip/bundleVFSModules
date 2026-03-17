 import BrowserStdout from 'browser-stdout';

if(globalThis.process){
process.stdout = browserStdout({ label: false });
}
