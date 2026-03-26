<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Parent-Side Execution Bridge</title>
    <style>
        body { font-family: sans-serif; background: #121212; color: #e0e0e0; padding: 20px; }
        #console { background: #000; border: 1px solid #444; padding: 10px; height: 200px; overflow-y: auto; font-family: monospace; }
        iframe { display: none; }
        .stdout { color: #0f0; }
        .stderr { color: #f44; }
        .system { color: #888; font-style: italic; }
    </style>
</head>
<body>

    <h2>Parent Console</h2>
    <div id="console"></div>
    
    <iframe id="runner"></iframe>

    <script type="module">
        /* ==========================================================
           PARENT SIDE: The "Bash" Engine & Message Router
           ========================================================== */
        const consoleEl = document.getElementById('console');
        const log = (msg, cls = '') => {
            const div = document.createElement('div');
            div.className = cls;
            div.textContent = msg;
            consoleEl.appendChild(div);
            consoleEl.scrollTop = consoleEl.scrollHeight;
        };

        // 1. Mock Bash Instance (Replace this with your actual instance)
        window.bashInstance = {
            async exec(command, options = {}) {
                log(`[Parent] Executing: ${command}`, 'system');
                
                // Simulate async work
                await new Promise(r => setTimeout(r, 800));

                if (command.includes('error')) {
                    return { stdout: '', stderr: 'Command not found or syntax error', exitCode: 1 };
                }
                return { 
                    stdout: `Output of (${command}) at ${new Date().toLocaleTimeString()}`, 
                    stderr: '', 
                    exitCode: 0 
                };
            }
        };

        // 2. Parent Listener: Handles requests from the iframe
        window.addEventListener('message', async (e) => {
            const { type, payload, requestId } = e.data;

            if (type === 'PARENT_EXEC_REQUEST') {
                try {
                    const result = await window.bashInstance.exec(payload.command, payload.options);

                    // Send result back to the specific iframe that requested it
                    e.source.postMessage({
                        type: 'EXEC_RESPONSE',
                        requestId: requestId,
                        payload: result
                    }, '*');

                } catch (err) {
                    e.source.postMessage({
                        type: 'EXEC_ERROR',
                        requestId: requestId,
                        payload: err.message
                    }, '*');
                }
            }

            // Logging for demo purposes
            if (type === 'STDOUT_LOG') log(`STDOUT: ${payload}`, 'stdout');
            if (type === 'STDERR_LOG') log(`STDERR: ${payload}`, 'stderr');
            if (type === 'RESULT_LOG') log(`Final Exit Code: ${payload.exitCode}`, 'system');
        });

        /* ==========================================================
           IFRAME BOOTSTRAP: Injecting the Proxy Logic
           ========================================================== */
        const iframe = document.getElementById('runner');
        
        const iframeCode = `
            <script type="module">
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
                export function exec(command, optionsOrCallback, callback) {
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

                        if (e.data.type === 'EXEC_RESPONSE') {
                            const { stdout, stderr, exitCode } = e.data.payload;
                            
                            if (stdout) {
                                parent.postMessage({ type: 'STDOUT_LOG', payload: stdout }, '*');
                                child.stdout.push(stdout);
                            }
                            if (stderr) {
                                parent.postMessage({ type: 'STDERR_LOG', payload: stderr }, '*');
                                child.stderr.push(stderr);
                            }

                            child.stdout.push(null);
                            child.stderr.push(null);
                            child.emit('exit', exitCode);
                            
                            if (cb) cb(exitCode !== 0 ? new Error('Failed') : null, stdout, stderr);
                            parent.postMessage({ type: 'RESULT_LOG', payload: e.data.payload }, '*');
                            window.removeEventListener('message', handler);
                        }
                    };

                    window.addEventListener('message', handler);
                    return child;
                }

                // Internal Test within Iframe
                console.log("Iframe Loaded. Running exec...");
                exec("ls -la", (err, stdout) => {
                    console.log("Iframe callback received stdout length:", stdout.length);
                });

                // Test an error case
                setTimeout(() => {
                    exec("force_error_command");
                }, 2000);

            <\/script>
        `;

        iframe.srcdoc = iframeCode;
    </script>
</body>
</html>
