// Export-surface parity: src/process.js  <->  node:process
// captured from real Node v24.20.0 (node:process)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/process.js';

const EXPECTED = ["_debugEnd","_debugProcess","_eval","_events","_eventsCount","_exiting","_fatalException","_getActiveHandles","_getActiveRequests","_kill","_linkedBinding","_maxListeners","_preload_modules","_rawDebug","_startProfilerIdleNotifier","_stopProfilerIdleNotifier","_tickCallback","abort","allowedNodeEnvironmentFlags","arch","argv","argv0","availableMemory","binding","chdir","config","constrainedMemory","cpuUsage","cwd","debugPort","default","dlopen","domain","emitWarning","env","execArgv","execPath","execve","exit","exitCode","features","finalization","getActiveResourcesInfo","getBuiltinModule","getegid","geteuid","getgid","getgroups","getuid","hasUncaughtExceptionCaptureCallback","hrtime","initgroups","kill","loadEnvFile","memoryUsage","moduleLoadList","nextTick","openStdin","pid","platform","ppid","reallyExit","ref","release","report","resourceUsage","setSourceMapsEnabled","setUncaughtExceptionCaptureCallback","setegid","seteuid","setgid","setgroups","setuid","sourceMapsEnabled","stderr","stdin","stdout","threadCpuUsage","title","umask","unref","uptime","version","versions"];

test('node:process export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
