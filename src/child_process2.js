const sleep = ms => new Promise(r => setTimeout(r, ms));
 
     import { EventEmitter } from "https://esm.sh/events";

                // Simple MockStream to handle data events
                class MockStream extends EventEmitter {
                    push(data) {
                        if (data === null) {
                            this.emit('end');
                        } else {
                            this.emit('data', data);
                        }
                    }
                }

                class ChildProcess extends EventEmitter {
                    constructor() {
                        super();
                        this.stdout = new MockStream();
                        this.stderr = new MockStream();
                        this.pid = Math.floor(Math.random() * 10000);
                    }
                }

                // The Proxy Exec Function
          function exec(command, optionsOrCallback, callback) {
                    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
                    const options = typeof optionsOrCallback === 'object' ? optionsOrCallback : {};
                    
                    const child = new ChildProcess();
                    const requestId = Math.random().toString(36).substring(7);

                    // Forward to Parent
                    parent.postMessage({
                        type: 'PARENT_EXEC_REQUEST',
                        requestId,
                        payload: { command, options }
                    }, '*');

                    const handler = (e) => {

                        if (e.data.requestId !== requestId) return;

                        if (e.data.type === 'PARENT_CHILD_EXEC_RESPONSE') {
                            const { stdout, stderr, exitCode } = e.data.payload;
                            
                           // 1. Handle Streams
                                   if (stdout) child.stdout.push(stdout);
                                   if (stderr) child.stderr.push(stderr);
                           
                                   child.stdout.push(null);
                                   child.stderr.push(null);
                           
                                   // 2. Construct the Error object if exitCode is non-zero
                                   let execError = null;
                                   if (exitCode !== 0) {
                                       // Match Node.js error properties
                                       execError = new Error(`Command failed: ${command}\n${stderr}`);
                                       execError.code = exitCode;
                                       execError.killed = false;
                                       execError.signal = null;
                                       execError.cmd = command;
                                       
                                       child.emit('error', execError);
                                   }
     
                            window.removeEventListener('message', handler);
                        }
                    };

                    window.addEventListener('message', handler);
                    return child;
                }

                // Internal Test within Iframe
                console.log("Iframe Loaded. Running exec...");
                exec("ls", (err, stdout) => {
                    console.log(err.message);
                });

                // Test an error case
                setTimeout(() => {
                    exec("force_error_command");
                }, 2000);

await sleep(5000);
