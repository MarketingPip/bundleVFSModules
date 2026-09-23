 my-vfs@1.0.0 test
> NODE_OPTIONS=--experimental-vm-modules jest

(node:2395) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:2396) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:2402) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:2402) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time
FAIL tests/module.test.js
  export surface
    ✕ ESM named exports match node:module exactly (28 ms)
    ✓ default export is the Module class (1 ms)
    ✓ Module.Module === Module
    ✓ Module.prototype own properties match real (4 ms)
    ✓ SourceMap.prototype own properties match real (1 ms)
  builtinModules / isBuiltin
    ✕ builtinModules is frozen and identical to real (8 ms)
    ✓ isBuiltin("fs") === true (4 ms)
    ✓ isBuiltin("node:fs") === true (1 ms)
    ✓ isBuiltin("fs/promises") === true (4 ms)
    ✓ isBuiltin("node:test/reporters") === true (1 ms)
    ✓ isBuiltin("test") === false (1 ms)
    ✓ isBuiltin("sea") === false (4 ms)
    ✓ isBuiltin("node:sea") === true (3 ms)
    ✓ isBuiltin("sqlite") === false (1 ms)
    ✕ isBuiltin("node:sqlite") === true (4 ms)
    ✓ isBuiltin("sys") === true
    ✓ isBuiltin("node:sys") === true
    ✓ isBuiltin("assert/strict") === true (1 ms)
    ✓ isBuiltin("_http_agent") === true (1 ms)
    ✓ isBuiltin("node:_http_agent") === true (3 ms)
    ✓ isBuiltin("nope") === false (1 ms)
    ✓ isBuiltin("node:nope") === false
    ✓ isBuiltin("") === false (5 ms)
    ✓ isBuiltin("node:") === false (5 ms)
    ✓ isBuiltin("fs/extra/deep") === false (1 ms)
    ✓ isBuiltin("internal/fs") === false
    ✓ isBuiltin("node:internal/fs") === false (1 ms)
    ✓ isBuiltin() with no args is false (does not throw)
  wrap
    ✓ Module.wrap matches real (1 ms)
    ✓ Module.wrapper matches real (3 ms)
  Module class
    ✓ constructor defaults match real (1 ms)
    ✓ parent linkage via constructor (1 ms)
    ✓ require validates its argument (4 ms)
    ✓ _cache / _extensions / _pathCache have null prototype (1 ms)
  _nodeModulePaths
    ✓ _nodeModulePaths("/a/b/c") matches real (1 ms)
    ✓ _nodeModulePaths("/") matches real
    ✓ _nodeModulePaths("/a/node_modules/b") matches real (1 ms)
    ✓ _nodeModulePaths("/x/y/z/") matches real
    ✓ _nodeModulePaths("/a//b/../c") matches real (1 ms)
    ✓ node_modules dirs are treated like any other dir
  loading
    ✓ require executes module code and caches (4 ms)
    ✓ json extension
    ✓ package main resolution (1 ms)
    ✓ node_modules lookup (1 ms)
    ✓ missing module throws MODULE_NOT_FOUND with require stack (2 ms)
    ✓ failed load removes the cache entry (let success = false) (3 ms)
    ✓ circular requires terminate (2 ms)
    ✓ builtin require delegates to the real builtin under Node
    ✓ require.resolve matches real for files (1 ms)
    ✓ require.resolve.paths matches real
  createRequire
    ✓ accepts absolute paths and file URLs (1 ms)
    ✓ rejects invalid filenames like real Node (1 ms)
    ✓ created require has the documented shape (1 ms)
    ✓ resolve validates like real Node (1 ms)
    ✓ resolve.paths validates like real Node
  error forms
    ✓ ERR_INVALID_ARG_TYPE includes [CODE] in String(err)
    ✓ MODULE_NOT_FOUND has no [CODE] in String(err) (2 ms)
    ✕ received-value rendering matches real Node (7 ms)
  compile cache
    ✕ constants match real (1 ms)
    ✕ enableCompileCache reports FAILED (cannot work in browser) (2 ms)
    ✓ getCompileCacheDir / flushCompileCache (1 ms)
  source maps
    ✕ getSourceMapsSupport default matches real
    ✕ setSourceMapsSupport validates like real (10 ms)
    ✓ SourceMap decodes like real (2 ms)
    ✓ findSourceMap returns undefined for unknown sources (1 ms)
    ✓ findSourceMap finds maps registered by _compile (2 ms)
  customization hooks
    ✓ registerHooks validates like real (1 ms)
    ✓ register validates the specifier like real (1 ms)
  findPackageJSON
    ✓ validates like real Node (1 ms)
    ✓ finds the nearest package.json (1 ms)
    ✓ missing package.json returns undefined
  stripTypeScriptTypes
    ✕ validates like real Node (2 ms)
    ✓ passes code through unchanged (1 ms)
    ✕ honors sourceUrl suffix like real
  globalPaths
    ✓ _initPaths honors NODE_PATH like real (1 ms)
  noop statics
    ✓ unimplementable APIs are noops, not throws (1 ms)
    ✓ _stat matches real (0 file, 1 dir, negative missing) (2 ms)
  browser fallback lane (no native delegation)
    ✓ pure APIs work without native delegation (1 ms)
    ✓ loads modules through the runtime __FS__ (1 ms)
    ✓ resolves package main and node_modules through __FS__ (1 ms)
    ✓ builtin require fails honestly with no native module available
    ✓ missing files throw MODULE_NOT_FOUND with a require stack
    ✓ Module._pathCache falls back to the shim store in the lane (1 ms)

  ● export surface › ESM named exports match node:module exactly

    expect(received).toEqual(expected) // deep equality

    - Expected  - 0
    + Received  + 9

    @@ -11,13 +11,22 @@
        "_pathCache",
        "_preloadModules",
        "_resolveFilename",
        "_resolveLookupPaths",
        "builtinModules",
    +   "constants",
        "createRequire",
    +   "enableCompileCache",
    +   "findPackageJSON",
        "findSourceMap",
    +   "flushCompileCache",
    +   "getCompileCacheDir",
    +   "getSourceMapsSupport",
        "globalPaths",
        "isBuiltin",
        "register",
    +   "registerHooks",
        "runMain",
    +   "setSourceMapsSupport",
    +   "stripTypeScriptTypes",
        "syncBuiltinESMExports",
      ]

      40 |     const realKeys = Object.keys(real).filter((k) => k !== 'default').sort();
      41 |     const shimKeys = Object.keys(shim).filter((k) => k !== 'default').sort();
    > 42 |     expect(shimKeys).toEqual(realKeys);
         |                      ^
      43 |   });
      44 |
      45 |   test('default export is the Module class', () => {

      at Object.<anonymous> (tests/module.test.js:42:22)

  ● builtinModules / isBuiltin › builtinModules is frozen and identical to real

    expect(received).toEqual(expected) // deep equality

    - Expected  - 0
    + Received  + 4

    @@ -65,6 +65,10 @@
        "v8",
        "vm",
        "wasi",
        "worker_threads",
        "zlib",
    +   "node:sea",
    +   "node:sqlite",
    +   "node:test",
    +   "node:test/reporters",
      ]

      73 |   test('builtinModules is frozen and identical to real', () => {
      74 |     expect(Object.isFrozen(shim.builtinModules)).toBe(true);
    > 75 |     expect([...shim.builtinModules]).toEqual([...real.builtinModules]);
         |                                      ^
      76 |     expect(shim.builtinModules.length).toBe(72);
      77 |     expect(shim.builtinModules).toContain('node:test/reporters');
      78 |     expect(shim.builtinModules).toContain('node:sea');

      at Object.<anonymous> (tests/module.test.js:75:38)

  ● builtinModules / isBuiltin › isBuiltin("node:sqlite") === true

    expect(received).toBe(expected) // Object.is equality

    Expected: false
    Received: true

      104 |   ])('isBuiltin(%p) === %p', (name, expected) => {
      105 |     expect(shim.isBuiltin(name)).toBe(expected);
    > 106 |     expect(shim.isBuiltin(name)).toBe(real.isBuiltin(name));
          |                                  ^
      107 |   });
      108 |
      109 |   test('isBuiltin() with no args is false (does not throw)', () => {

      at tests/module.test.js:106:34

  ● error forms › received-value rendering matches real Node

    expect(received).toBe(expected) // Object.is equality

    Expected: "TypeError: real.setSourceMapsSupport is not a function"
    Received: "TypeError [ERR_INVALID_ARG_TYPE]: The \"options.nodeModules\" property must be of type boolean. Received an instance of Object"

      398 |       try { shim.setSourceMapsSupport(true, { nodeModules: v }); } catch (e) { mine = String(e); }
      399 |       try { real.setSourceMapsSupport(true, { nodeModules: v }); } catch (e) { theirs = String(e); }
    > 400 |       expect(mine).toBe(theirs);
          |                    ^
      401 |     }
      402 |   });
      403 | });

      at Object.<anonymous> (tests/module.test.js:400:20)

  ● compile cache › constants match real

    expect(received).toEqual(expected) // deep equality

    Expected: undefined
    Received: {"compileCacheStatus": {"ALREADY_ENABLED": 2, "DISABLED": 3, "ENABLED": 1, "FAILED": 0}}

      408 | describe('compile cache', () => {
      409 |   test('constants match real', () => {
    > 410 |     expect(shim.constants).toEqual(real.constants);
          |                            ^
      411 |     expect(shim.constants.compileCacheStatus).toEqual({
      412 |       FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3,
      413 |     });

      at Object.<anonymous> (tests/module.test.js:410:28)

  ● compile cache › enableCompileCache reports FAILED (cannot work in browser)

    TypeError: Cannot read properties of undefined (reading 'compileCacheStatus')

      417 |     expect(shim.enableCompileCache()).toEqual({ status: 0, directory: undefined });
      418 |     expect(shim.enableCompileCache('/tmp/x').status)
    > 419 |       .toBe(real.constants.compileCacheStatus.FAILED);
          |                            ^
      420 |   });
      421 |
      422 |   test('getCompileCacheDir / flushCompileCache', () => {

      at Object.<anonymous> (tests/module.test.js:419:28)

  ● source maps › getSourceMapsSupport default matches real

    TypeError: real.getSourceMapsSupport is not a function

      432 |   test('getSourceMapsSupport default matches real', () => {
      433 |     expect(shim.getSourceMapsSupport()).toEqual(
    > 434 |       JSON.parse(JSON.stringify(real.getSourceMapsSupport())),
          |                                      ^
      435 |     );
      436 |   });
      437 |

      at Object.<anonymous> (tests/module.test.js:434:38)

  ● source maps › setSourceMapsSupport validates like real

    expect(received).toBe(expected) // Object.is equality

    Expected: "TypeError: real.setSourceMapsSupport is not a function"
    Received: "TypeError [ERR_INVALID_ARG_TYPE]: The \"enabled\" argument must be of type boolean. Received null"

      441 |       try { shim.setSourceMapsSupport(...args); } catch (e) { mine = String(e); }
      442 |       try { real.setSourceMapsSupport(...args); } catch (e) { theirs = String(e); }
    > 443 |       expect(mine).toBe(theirs);
          |                    ^
      444 |     }
      445 |     shim.setSourceMapsSupport(true, { nodeModules: true, generatedCode: false });
      446 |     expect(shim.getSourceMapsSupport().enabled).toBe(true);

      at Object.<anonymous> (tests/module.test.js:443:20)

  ● stripTypeScriptTypes › validates like real Node

    expect(received).toBe(expected) // Object.is equality

    Expected: "TypeError: real.stripTypeScriptTypes is not a function"
    Received: "TypeError [ERR_INVALID_ARG_TYPE]: The \"code\" argument must be of type string. Received type number (42)"

      586 |       try { shim.stripTypeScriptTypes(...args); } catch (e) { mine = String(e); }
      587 |       try { real.stripTypeScriptTypes(...args); } catch (e) { theirs = String(e); }
    > 588 |       expect(mine).toBe(theirs);
          |                    ^
      589 |     }
      590 |   });
      591 |

      at Object.<anonymous> (tests/module.test.js:588:20)

  ● stripTypeScriptTypes › honors sourceUrl suffix like real

    TypeError: real.stripTypeScriptTypes is not a function

      597 |   test('honors sourceUrl suffix like real', () => {
      598 |     expect(shim.stripTypeScriptTypes('x', { mode: 'strip', sourceUrl: 'foo.ts' }))
    > 599 |       .toBe(real.stripTypeScriptTypes('x', { mode: 'strip', sourceUrl: 'foo.ts' }));
          |                  ^
      600 |     expect(shim.stripTypeScriptTypes('x', { sourceUrl: '' })).toBe('x');
      601 |   });
      602 | });

      at Object.<anonymous> (tests/module.test.js:599:18)

PASS tests/net.test.js
  export surface
    ✓ exposes the full node:net export set (7 ms)
    ✓ Stream === Socket (2 ms)
    ✓ constructors work without new (3 ms)
  isIP / isIPv4 / isIPv6
    ✓ isIP("127.0.0.1") === 4 (10 ms)
    ✓ isIP("0.0.0.0") === 4 (3 ms)
    ✓ isIP("255.255.255.255") === 4 (1 ms)
    ✓ isIP("192.168.1.1") === 4 (5 ms)
    ✓ isIP("10.0.0.255") === 4 (1 ms)
    ✓ isIP("::1") === 6 (2 ms)
    ✓ isIP("::") === 6 (1 ms)
    ✓ isIP("fe80::1") === 6 (8 ms)
    ✓ isIP("2001:db8::1") === 6 (1 ms)
    ✓ isIP("::ffff:127.0.0.1") === 6 (3 ms)
    ✓ isIP("fe80::1%eth0") === 6
    ✓ isIP("2001:0db8:85a3:0000:0000:8a2e:0370:7334") === 6 (1 ms)
    ✓ isIP("256.1.1.1") === 0 (6 ms)
    ✓ isIP("01.02.03.04") === 0 (4 ms)
    ✓ isIP("12.34.56.078") === 0
    ✓ isIP("1.2.3") === 0 (1 ms)
    ✓ isIP("1.2.3.4.5") === 0 (2 ms)
    ✓ isIP("1::2::3") === 0 (1 ms)
    ✓ isIP("gggg::1") === 0 (1 ms)
    ✓ isIP("not-an-ip") === 0 (1 ms)
    ✓ isIP("") === 0
    ✓ isIP("12345") === 0 (1 ms)
    ✓ isIP("1.2.3.4:80") === 0
  SocketAddress
    ✓ defaults (1 ms)
    ✓ ipv6 requires explicit family (9 ms)
    ✓ family mismatch throws (1 ms)
    ✓ non-object options throw (1 ms)
    ✓ canonicalizes ipv6 (1 ms)
  BlockList
    ✓ add/check/rules ordering (newest first) (2 ms)
    ✓ check returns false for malformed input (1 ms)
    ✓ ipv6 rules (2 ms)
    ✓ addRange start > end throws (1 ms)
    ✓ toJSON / fromJSON round-trip (Node format: rule strings) (2 ms)
    ✓ fromJSON validates input like Node (6 ms)
    ✓ ipv6 fromJSON round-trip (1 ms)
  autoSelectFamily defaults
    ✓ defaults match Node (1 ms)
    ✓ setters validate (6 ms)
  Socket states
    ✓ fresh socket shape matches Node (2 ms)
    ✓ connect() with no args throws ERR_MISSING_ARGS (2 ms)
    ✓ invalid ports throw ERR_SOCKET_BAD_PORT synchronously (9 ms)
    ✓ setTimeout validation mirrors Node (5 ms)
    ✓ setTimeout assigns before validating (Node quirk) (1 ms)
    ✓ setTimeout is a noop on destroyed sockets (1 ms)
    ✓ setNoDelay / setKeepAlive / ref / unref return this (2 ms)
    ✓ timeout event fires (34 ms)
  virtual loopback
    ✓ echo server round-trip with addresses and byte counts (8 ms)
    ✓ server sees client addresses; half-close delivers end both ways (3 ms)
    ✓ client destroy() delivers end to a paused server socket (52 ms)
    ✓ destroy(err) emits error then close(true), in order (6 ms)
    ✓ resetAndDestroy gives the peer ECONNRESET (1 ms)
    ✓ getConnections counts live connections (4 ms)
    ✓ maxConnections triggers drop (5 ms)
    ✓ server blockList refuses connections (1 ms)
  connection failures
    ✓ refused TCP (no host) -> bare ECONNREFUSED then close(true) (1 ms)
    ✓ refused TCP (IP host) -> detailed ECONNREFUSED (1 ms)
    ✓ missing pipe -> ENOENT (1 ms)
    ✓ unresolvable host -> ENOTFOUND (1 ms)
    ✓ connect callback fires on success (1 ms)
  Server
    ✓ listen() with no args binds an ephemeral port; address() shape (1 ms)
    ✓ listen(port, host) (1 ms)
    ✓ double listen throws ERR_SERVER_ALREADY_LISTEN (1 ms)
    ✓ listen({}) throws ERR_INVALID_ARG_VALUE (1 ms)
    ✓ listen on a taken port emits EADDRINUSE (1 ms)
    ✓ close() on a non-listening server still emits close; callback gets ERR_SERVER_NOT_RUNNING (1 ms)
    ✓ close(callback) fires after connections drain (103 ms)
    ✓ getConnections without callback throws (1 ms)
    ✓ constructor validates options (1 ms)
    ✓ pipe listen + connect (2 ms)
  allowHalfOpen and transport lifecycle
    ✓ allowHalfOpen defaults to false on client and server sockets (2 ms)
    ✓ createServer({ allowHalfOpen: true }) propagates to accepted sockets (1 ms)
    ✓ write after local end and remote FIN fails with EPIPE (3 ms)
    ✓ concurrent half-open scenarios both settle (test-net-allow-half-open) (5 ms)
    ✓ dead server-side socket releases its loop-keeper; server.close settles (1 ms)
  browser-fallback lane
    ✓ works with native builtins disabled (no process.getBuiltinModule use) (1 ms)

(node:2396) Warning: settings.maxHeaderSize overwrite settings.maxHeaderListSize
(node:2396) Warning: settings.maxHeaderSize overwrite settings.maxHeaderListSize
(node:2396) Warning: settings.maxHeaderSize overwrite settings.maxHeaderListSize
(node:2395) [DEP0118] DeprecationWarning: The provided hostname "" is not a valid hostname, and is supported in the dns module solely for compatibility.
PASS tests/http2.test.js
  constants
    ✓ matches the real node:http2 constants object exactly (8 ms)
    ✓ has 240 entries (1 ms)
    ✓ spot-check key values (2 ms)
  settings utilities
    ✓ getDefaultSettings() matches real node:http2 (1 ms)
    ✓ returns a fresh object each call (3 ms)
    ✓ getPackedSettings({}) matches Node byte-for-byte (1 ms)
    ✓ getPackedSettings({"headerTableSize":0}) matches Node byte-for-byte (1 ms)
    ✓ getPackedSettings({"enablePush":false}) matches Node byte-for-byte (1 ms)
    ✓ getPackedSettings({"enablePush":true}) matches Node byte-for-byte (3 ms)
    ✓ getPackedSettings({"maxConcurrentStreams":100}) matches Node byte-for-byte
    ✓ getPackedSettings({"initialWindowSize":1024}) matches Node byte-for-byte (1 ms)
    ✓ getPackedSettings({"maxFrameSize":32768}) matches Node byte-for-byte (1 ms)
    ✓ getPackedSettings({"maxHeaderListSize":100000}) matches Node byte-for-byte
    ✓ getPackedSettings({"enableConnectProtocol":true}) matches Node byte-for-byte (1 ms)
    ✓ getPackedSettings({"headerTableSize":4096,"enablePush":true,"initialWindowSize":65535,"maxFrameSize":16384,"maxConcurrentStreams":4294967295,"maxHeaderListSize":65535,"enableConnectProtocol":false}) matches Node byte-for-byte
    ✓ getPackedSettings({"bogus":123}) matches Node byte-for-byte (1 ms)
    ✓ getPackedSettings({"maxConcurrentStreams":1.5}) matches Node byte-for-byte
    ✓ getUnpackedSettings round-trips packed settings (1 ms)
    ✓ getUnpackedSettings maps unknown ids to customSettings, like Node (1 ms)
    ✓ getPackedSettings rejects out-of-range values with ERR_HTTP2_INVALID_SETTING_VALUE
    ✓ getPackedSettings rejects non-objects with ERR_INVALID_ARG_TYPE
    ✓ boolean settings require real booleans, like Node (1 ms)
    ✓ undefined values are skipped and NaN returns undefined, like Node (1 ms)
    ✓ getUnpackedSettings rejects bad lengths with ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH (1 ms)
    ✓ getPackedSettings() with no argument returns an empty Buffer, like Node
    ✓ maxHeaderSize aliases id 6 and wins over maxHeaderListSize, like Node (1 ms)
    ✓ customSettings pack byte-for-byte like Node, including quirks
    ✓ customSettings validation mirrors Node
    ✓ settings errors have Node-exact names, codes, and messages (7 ms)
    ✓ getUnpackedSettings reads TypedArray elements like Node and validates (1 ms)
    ✓ session.settings applies validated settings including id-6 aliasing (4 ms)
  sensitiveHeaders
    ✓ is a symbol like the real one
  Http2Session
    ✓ class hierarchy and session types (1 ms)
    ✓ default property values (1 ms)
    ✓ ping() returns true and calls back async with (null, duration, payload) (11 ms)
    ✓ ping() echoes a provided payload (1 ms)
    ✓ ping() on a closed session throws ERR_HTTP2_INVALID_SESSION (1 ms)
    ✓ close() emits close and runs the callback asynchronously (12 ms)
    ✓ destroy(error) emits error then close (1 ms)
    ✓ settings() merges locally and calls back (null, settings, duration) (1 ms)
    ✓ settings() with an invalid value throws ERR_HTTP2_INVALID_SETTING_VALUE
    ✓ setNextStreamID validates (1 ms)
    ✓ ref()/unref() return the session (1 ms)
    ✓ noops do not throw: goaway, rstStream, priority, setLocalWindowSize, setTimeout (4 ms)
  Http2Stream
    ✓ default property values for a pending stream (1 ms)
    ✓ exposes the real method shapes (2 ms)
    ✓ respond() records sentHeaders without I/O (1 ms)
    ✓ pushStream() reports ERR_HTTP2_PUSH_DISABLED asynchronously
    ✓ write()/end() buffer the request body (1 ms)
    ✓ rstStream sets rstCode and destroys
  Http2Server
    ✓ createServer returns an Http2Server (an EventEmitter) (1 ms)
    ✓ createSecureServer returns an Http2SecureServer (1 ms)
    ✓ listen() emits listening async and address() reports the port (1 ms)
  virtual client/server loop
    ✓ connect() returns a ClientHttp2Session and emits connect async (1 ms)
    ✓ request/response round trip through a createServer handler (8 ms)
    ✓ client-initiated streams use ascending odd ids (51 ms)
    ✓ raw stream event handlers can respond() and end() (1 ms)
    ✓ compat request event delivers method, url and headers (1 ms)
    ✓ request() with no registered server emits ECONNREFUSED
    ✓ https connect() marks the session encrypted
    ✓ connect() validates its authority like Node (1 ms)
    ✓ performServerHandshake returns a ServerHttp2Session
  exports
    ✓ default export matches named exports (1 ms)
  browser fallback (no native builtins)
    ✓ constants and settings work with native builtins hidden (4 ms)
    ✓ virtual loop works with native builtins hidden (2 ms)
    ✓ session ping works with native builtins hidden (4 ms)

PASS tests/test.test.js
  node:test Browser Shim
    ✓ run() emits pass/fail events as { type, data } (4 ms)
    ✓ run() is a live async iterable of events (2 ms)
    ✓ run() respects testNamePatterns (1 ms)
    mock (named export)
      ✓ mock.fn() tracks calls and arguments (4 ms)
      ✓ mock.method() patches and restores objects (2 ms)
    mock.timers
      ✓ tick() advances time and triggers setTimeout (2 ms)
    named exports
      ✓ default export and named test export are the same function (1 ms)
      ✓ it is the same function object as test (Node: test.it === test) (1 ms)
      ✓ describe is the same function object as suite (1 ms)
      ✓ all named exports are bolted onto the test function (CJS parity) (3 ms)
      ✓ top-level only/skip/todo are functions (1 ms)
      ✓ snapshot exposes setDefaultSnapshotSerializers and setResolveSnapshotPath (1 ms)
      ✓ assert exposes register()
      ✓ reporters are NOT exported from node:test (only from node:test/reporters) (2 ms)
      ✓ internal classes are NOT exported (MockTracker, MockTimers, SkipError, etc.) (2 ms)
    Test Execution Flow
      ✓ runs a basic suite and reports passes (3 ms)
      ✓ nested run produces valid TAP with plans and directives (6 ms)
      ✓ enforces timeout on slow tests (54 ms)
      ✓ timeout aborts t.signal (53 ms)
    hooks
      ✓ before/after/beforeEach/afterEach run in order (3 ms)
    only/skip/todo
      ✓ only marks are ignored by default (matches Node) (3 ms)
      ✓ run({ testOnly: true }) runs only marked tests (3 ms)
      ✓ describe.only runs the whole subtree in only-mode (4 ms)
      ✓ top-level only()/skip()/todo() schedule marked tests (4 ms)
    expectFailure
      ✓ a failing test is reported as pass with # EXPECTED FAILURE (2 ms)
      ✓ an unexpected pass is reported as failure (3 ms)
    skip/todo context calls
      ✓ t.skip() does not abort the body; reports pass with skip (3 ms)
      ✓ t.todo() does not abort the body; reports pass with todo (2 ms)
      ✓ todo option runs the body (unlike skip) (2 ms)
      ✓ a failing todo test still fails, keeping the todo flag (3 ms)
      ✓ skip wins over todo: todo flag is cleared (2 ms)
      ✓ a skipped suite emits test:pass with skip and type suite (2 ms)
      ✓ testIds are numeric and stable across start/complete/pass (2 ms)
    getTestContext
      ✓ returns the current test context inside a test, undefined outside
    Assertions (t.assert)
      ✓ deepEqual identifies nested mismatches (2 ms)
    reporters (node:test/reporters)
      ✓ tap() yields TAP from the run() stream (2 ms)
      ✓ spec() yields human-readable output (2 ms)
      ✓ dot() yields one char per test plus a failure block (1 ms)
      ✓ junit() yields JUnit XML (2 ms)
      ✓ lcov() yields empty string without coverage data (1 ms)
    _RUNTIME_._TEST_RUNNER_ hook
      ✓ host configuration survives the module wiring (1 ms)
      ✓ REPORTER_TYPE is honoured lazily by execute() (2 ms)
    browser fallback (no native delegation)
      ✓ runner works with native builtins disabled (7 ms)
      ✓ mock.fn works with native builtins disabled (1 ms)
      ✓ reporters transform the stream with native builtins disabled (7 ms)

PASS tests/http.test.js
  constants
    ✓ METHODS: 35 sorted methods (5 ms)
    ✓ STATUS_CODES: 63 entries with spot checks (2 ms)
    ✓ maxHeaderSize is 16384
  header validation
    ✓ validateHeaderName accepts tokens (1 ms)
    ✓ validateHeaderName rejects non-tokens (1 ms)
    ✓ validateHeaderValue accepts valid values (coerces) (1 ms)
    ✓ validateHeaderValue rejects undefined and bad chars (1 ms)
    ✓ setMaxIdleHTTPParsers validates like Node (2 ms)
  _http_common internals
    ✓ token and header-char checks (7 ms)
    ✓ CRLF and expressions (1 ms)
    ✓ internal method order starts DELETE, GET, HEAD (not sorted) (1 ms)
  Agent
    ✓ default options match Node (1 ms)
    ✓ globalAgent differs by keepAlive (1 ms)
    ✓ options are honored
    ✓ invalid scheduling and maxTotalSockets throw
    ✓ getName and destroy
  OutgoingMessage headers
    ✓ set/get/has/remove/append (1 ms)
    ✓ getHeaders/getHeaderNames/getRawHeaderNames (1 ms)
    ✓ setHeader validates name and value (1 ms)
    ✓ headersSent flips after writeHead; later setHeader throws (1 ms)
    ✓ writeHead validates status code (1 ms)
    ✓ setHeaders Headers/Map form (17 ms)
  ServerResponse
    ✓ fresh statusMessage is undefined; writeHead fills it (1 ms)
    ✓ end resolves with status/headers/body (2 ms)
    ✓ 204 drops the body
    ✓ Express-style .status().json() (1 ms)
    ✓ writeHead array headers
  IncomingMessage
    ✓ fromRequest builds method/url/headers/body (2 ms)
    ✓ fromFetchResponse converts a fetch response (1 ms)
  Server
    ✓ listen/close lifecycle and address (1 ms)
    ✓ request listener fires exactly once per request (2 ms)
    ✓ handleRequest round trip with headers and echo (1 ms)
    ✓ EADDRINUSE when the port is taken (3 ms)
    ✓ ephemeral port when listen() has no port
    ✓ connection helpers are noops (1 ms)
  runtime bridge (__httpServerRunTime)
    ✓ bridge is published with handleRequest + waitForAllServers (49 ms)
    ✓ documented arg order (port, url, method, body, headers) (43 ms)
    ✓ legacy arg order (port, method, url, headers, body) still works (41 ms)
    ✓ no server on the port rejects with ERR_NO_SERVER (39 ms)
    ✓ waitForAllServers resolves once servers close (39 ms)
  ClientRequest (fetch bridge)
    ✓ request builds the fetch URL and passes method/headers/body (3 ms)
    ✓ get() issues a GET and ends the request (1 ms)
    ✓ network failure emits error (1 ms)
    ✓ invalid method throws ERR_INVALID_HTTP_TOKEN
    ✓ protocol mismatch with agent throws ERR_INVALID_PROTOCOL (1 ms)
    ✓ timeout emits timeout (no auto-abort, like Node) (21 ms)
  WebSocket helpers
    ✓ known SHA-1 accept vector (RFC 6455)
    ✓ frame round trip (unmasked) (1 ms)
    ✓ frame round trip (masked, client-style) (1 ms)
  internal module consistency
    ✓ _http_agent re-exports the same Agent/globalAgent (1 ms)
    ✓ _http_client re-exports ClientRequest (1 ms)
    ✓ _http_incoming re-exports IncomingMessage plus symbols (1 ms)
    ✓ _http_outgoing re-exports and parses unique headers (2 ms)
    ✓ _http_server re-exports and stubs connection helpers (1 ms)

PASS tests/process.test.js
  process shim — identity & exports
    ✓ Symbol.toStringTag is "process" (matches real node:process) (2 ms)
    ✓ module installs itself as globalThis.process during import
    ✓ named exports agree with the default export (data) (3 ms)
    ✓ named exports agree with the default export (methods exist & behave) (9 ms)
    ✓ standalone fallbacks are sane with no _RUNTIME_ (3 ms)
    ✓ features has exactly the key set real Node v24.20.0 exposes (1 ms)
    ✓ allowedNodeEnvironmentFlags is a Set (empty: no NODE_OPTIONS in browser) (1 ms)
    ✓ config has Node-shaped target_defaults/variables (1 ms)
    ✓ report has Node's exact key set (1 ms)
  process shim — _RUNTIME_ mirroring
    ✓ mirrors a fake globalThis._RUNTIME_.process with zero native delegation (6 ms)
    ✓ does not consult native process.getBuiltinModule (stubbed to throw) (5 ms)
  process shim — hrtime
    ✓ hrtime() returns [seconds, nanoseconds] (1 ms)
    ✓ hrtime(prev) returns the diff (1 ms)
    ✓ hrtime.bigint() returns a positive bigint
    ✓ hrtime validation matches Node (5 ms)
  process shim — nextTick
    ✓ throws ERR_INVALID_ARG_TYPE without a function (2 ms)
    ✓ runs callback with args on the microtask queue (1 ms)
    ✓ callback args are passed through
    ✓ throwing callback routes to uncaughtException listeners (20 ms)
    ✓ throwing callback routes to the capture callback when set (21 ms)
    ✓ setUncaughtExceptionCaptureCallback validates like Node (1 ms)
  process shim — exit / reallyExit / kill / abort
    ✓ exit(code) sets exitCode, emits exit synchronously, returns undefined (4 ms)
    ✓ exit() with no args uses exitCode, defaulting to 0 (3 ms)
    ✓ exit() picks up a preset exitCode (3 ms)
    ✓ exit validation matches Node (5 ms)
    ✓ reallyExit skips listeners but records the code (4 ms)
    ✓ kill validates like Node and is otherwise a host-notifying noop (5 ms)
    ✓ abort() is a noop that never throws (4 ms)
  process shim — umask / cwd / chdir
    ✓ umask round-trips and accepts octal strings (3 ms)
    ✓ umask validation matches Node (4 ms)
    ✓ cwd/chdir work standalone (4 ms)
    ✓ chdir validates like Node (5 ms)
    ✓ chdir validates against the virtual FS when present (4 ms)
  process shim — resource info
    ✓ memoryUsage has Node's keys with numeric values (1 ms)
    ✓ cpuUsage returns zeros and validates prevValue (2 ms)
    ✓ uptime is a non-negative number
    ✓ resourceUsage has all 16 Node keys (4 ms)
    ✓ availableMemory/constrainedMemory/getActiveResourcesInfo shapes
  process shim — posix, stubs, events
    ✓ uid/gid are root-like noops (1 ms)
    ✓ impossible APIs are noops with correct shapes (1 ms)
    ✓ dlopen/getBuiltinModule validate like Node (1 ms)
    ✓ setSourceMapsEnabled toggles sourceMapsEnabled
    ✓ EventEmitter basics: on/once/off/emit/listenerCount (1 ms)
    ✓ on() validates its listener (1 ms)
    ✓ emitWarning delivers an Error to warning listeners (21 ms)
    ✓ emitWarning validates like Node (1 ms)
    ✓ stdin/stdout/stderr stream shims exist with expected shape (1 ms)

(node:2396) ExperimentalWarning: WASI is an experimental feature and might change at any time
PASS tests/wasi.test.js
  export shape
    ✓ WASI is exported by name and as the default export (3 ms)
  constructor validation (mirrors test-wasi-options-validation.js)
    ✓ version is required (1 ms)
    ✓ options=null throws ERR_INVALID_ARG_TYPE (1 ms)
    ✓ options="foo" throws ERR_INVALID_ARG_TYPE (1 ms)
    ✓ options="" throws ERR_INVALID_ARG_TYPE
    ✓ options=0 throws ERR_INVALID_ARG_TYPE (1 ms)
    ✓ options=NaN throws ERR_INVALID_ARG_TYPE (1 ms)
    ✓ options=Symbol(s) throws ERR_INVALID_ARG_TYPE
    ✓ options=true throws ERR_INVALID_ARG_TYPE (5 ms)
    ✓ options=false throws ERR_INVALID_ARG_TYPE
    ✓ options=[Function anonymous] throws ERR_INVALID_ARG_TYPE (1 ms)
    ✓ version must be a string (1 ms)
    ✓ unsupported version throws ERR_INVALID_ARG_VALUE (1 ms)
    ✓ both supported versions construct
    ✓ args defaults to [] and must be an Array
    ✓ env must be an Object
    ✓ preopens must be an Object (1 ms)
    ✓ returnOnExit must be a boolean (1 ms)
    ✓ stdin must be an int32 >= 0 (1 ms)
    ✓ stdout must be an int32 >= 0 (1 ms)
    ✓ stderr must be an int32 >= 0 (1 ms)
  getImportObject
    ✓ preview1 uses wasi_snapshot_preview1 (1 ms)
    ✓ unstable uses wasi_unstable (1 ms)
  wasiImport shape
    ✓ contains the full preview1 syscall surface as functions (1 ms)
    ✓ unimplemented syscalls return __WASI_ERRNO_NOSYS (52), never throw (1 ms)
  finalizeBindings / start / initialize validation
    ✓ start() with no instance throws like Node (1 ms)
    ✓ start() rejects null exports like Node (1 ms)
    ✓ start() requires a _start function
    ✓ start() rejects an _initialize export with Node’s exact message (1 ms)
    ✓ start() requires a real WebAssembly.Memory with the native message (1 ms)
    ✓ start() can only be called once
    ✓ initialize() rejects a _start export (1 ms)
    ✓ initialize() calls _initialize when present, ok when absent (2 ms)
    ✓ finalizeBindings twice throws ERR_WASI_ALREADY_STARTED
  honest syscall behaviour
    ✓ start() returns the proc_exit code (returnOnExit=true) (1 ms)
    ✓ start() returns 0 when _start returns normally (1 ms)
    ✓ proc_exit with returnOnExit=false raises WASI_EXIT instead of exiting
    ✓ args_get / args_sizes_get round-trip through guest memory (1 ms)
    ✓ environ_get / environ_sizes_get serialise KEY=VALUE
    ✓ fd_write to stdout/stderr reaches the console; bad fds give BADF (2 ms)
    ✓ fd_read on stdin returns EOF (0 bytes) (1 ms)
    ✓ clock_time_get returns plausible realtime/monotonic values (1 ms)
    ✓ random_get fills the guest buffer with non-trivial bytes
    ✓ sched_yield is a successful noop (1 ms)
  preopen filesystem (shim engine)
    ✓ preopen fd exposes the guest path via fd_prestat_dir_name (1 ms)
    ✓ path_open + fd_write + fd_seek + fd_read round-trip a file (5 ms)
    ✓ path_open without O_CREAT fails for a missing file
    ✓ fd_readdir lists files created in the preopen (1 ms)
    ✓ path_create_directory and path_filestat_get work on the preopen (1 ms)
  browser fallback (no native builtins, no Buffer)
    ✓ constructor validation still matches Node exactly (1 ms)
    ✓ start/initialize lifecycle works on mock instances (1 ms)
    ✓ args syscalls work without native delegation (1 ms)

PASS tests/child_process.test.js
  argument validation (exact Node v24.20.0 errors)
    ✓ exec: command must be a string (61 ms)
    ✓ exec: command must not contain null bytes (36 ms)
    ✓ exec: bad callback (38 ms)
    ✓ exec: timeout out of range (45 ms)
    ✓ exec: maxBuffer out of range (35 ms)
    ✓ exec: bad killSignal (28 ms)
    ✓ exec: bad signal (29 ms)
    ✓ exec: string options do not throw (Node quirk) (53 ms)
    ✓ execFile: file must be a non-empty string (27 ms)
    ✓ execFile: args must be an array or options object (32 ms)
    ✓ execFile: null bytes in args (27 ms)
    ✓ execFile inherits spawn-level option validation (27 ms)
    ✓ spawn: file must be a non-empty string (20 ms)
    ✓ spawn: args type errors (20 ms)
    ✓ spawn: options type errors (19 ms)
    ✓ fork: modulePath validation (21 ms)
    ✓ spawnSync/execSync/execFileSync validation (26 ms)
    ✓ null bytes rejected with exact Node messages (32 ms)
  ChildProcess shape
    ✓ spawn child matches Node observable shape (30 ms)
    ✓ spawn with shell:true rewrites to /bin/sh -c (23 ms)
    ✓ spawn with shell string uses it (23 ms)
    ✓ exec child uses /bin/sh -c (28 ms)
    ✓ spawn emits "spawn" asynchronously (36 ms)
  kill() semantics
    ✓ kill validates the signal, even on a dead child (42 ms)
    ✓ kill() returns true while alive, emits exit/close async (42 ms)
    ✓ kill(0) tests existence without terminating (41 ms)
    ✓ kill("sigterm") is case-insensitive like Node (40 ms)
  fork() (browser noop)
    ✓ fork child has the IPC surface and starts connected (19 ms)
    ✓ fork validates null bytes like Node (24 ms)
    ✓ fork send() reports ERR_IPC_CHANNEL_CLOSED (20 ms)
    ✓ fork disconnect() emits disconnect; twice errors (23 ms)
  sync noops (validated, honest shapes)
    ✓ spawnSync returns Node key order and shapes (24 ms)
    ✓ spawnSync honors encoding (32 ms)
    ✓ execSync/execFileSync return empty stdout (Buffer by default) (26 ms)
  host postMessage protocol
    ✓ exec posts PARENT_EXEC_REQUEST and resolves the callback (29 ms)
    ✓ exec failure: callback gets the error, child does NOT emit error (40 ms)
    ✓ execFile quotes args into the command string (39 ms)
    ✓ spawn posts PARENT_SPAWN_REQUEST and finalizes on response (32 ms)
    ✓ kill() before the parent responds finalizes without error (42 ms)
    ✓ options.signal abort kills the child with AbortError (40 ms)
    ✓ exec timeout rejects with ETIMEDOUT (50 ms)
    ✓ exec maxBuffer reports ERR_CHILD_PROCESS_STDIO_MAXBUFFER (27 ms)
    ✓ exec encoding "buffer" yields Buffers (21 ms)
  promisify.custom
    ✓ exec and execFile expose promisify.custom with .child (25 ms)
    ✓ promisified exec rejects with stdout/stderr attached (20 ms)
  standalone degradation (no window)
    ✓ spawn without a window emits ERR_NO_WINDOW and finalizes (32 ms)
    ✓ spawn without a parent frame emits ERR_NO_PARENT (24 ms)

PASS tests/fs.test.js
  basic file I/O
    ✓ writeFileSync/readFileSync roundtrip (4 ms)
    ✓ writeFileSync/readFileSync binary roundtrip (2 ms)
    ✓ appendFileSync appends (1 ms)
    ✓ readFile callback (1 ms)
    ✓ readFile missing → ENOENT with errno/syscall (4 ms)
    ✓ readFileSync missing → ENOENT (1 ms)
    ✓ readFile accepts fd (1 ms)
    ✓ unknown encoding → ERR_INVALID_ARG_VALUE, no syscall (1 ms)
  Stats shape
    ✓ enumerable keys match Node (1 ms)
    ✓ date fields are prototype getters returning Date (1 ms)
    ✓ type methods (1 ms)
    ✓ bigint stats have *Ns fields (1 ms)
    ✓ lstat does not follow symlinks (1 ms)
  Dirent shape
    ✓ enumerable keys are name, parentPath (1 ms)
  descriptors
    ✓ positional read preserves cursor (1 ms)
    ✓ positional write preserves cursor (1 ms)
    ✓ read from write-only fd → EBADF
    ✓ write to read-only fd → EBADF (1 ms)
    ✓ readvSync/writevSync (2 ms)
    ✓ read beyond EOF returns 0 (1 ms)
    ✓ ArrayBuffer/DataView normalization (1 ms)
  directories
    ✓ mkdir recursive (1 ms)
    ✓ recursive mkdir on existing file → EEXIST (4 ms)
    ✓ readdir recursive (1 ms)
    ✓ rename dir->file → ENOTDIR; file->dir → EISDIR (2 ms)
    ✓ unlink directory → EISDIR (1 ms)
    ✓ rm dir without recursive → ERR_FS_EISDIR (1 ms)
  truncate
    ✓ negative length → 0 (1 ms)
    ✓ fractional length → ERR_OUT_OF_RANGE, no syscall (1 ms)
  access
    ✓ F_OK on existing file (1 ms)
    ✓ missing file → ENOENT (1 ms)
    ✓ W_OK on 0444 → EACCES (1 ms)
    ✓ bad mode type → ERR_INVALID_ARG_TYPE
  cp
    ✓ cp file (2 ms)
    ✓ cp dir without recursive → ERR_FS_EISDIR (1 ms)
    ✓ cp dir recursive
    ✓ cp missing src → ENOENT syscall lstat (1 ms)
    ✓ cp file onto dir → ERR_FS_CP_NON_DIR_TO_DIR (1 ms)
    ✓ cp mode > 7 → ERR_OUT_OF_RANGE
  glob
    ✓ globSync relative → cwd-relative results (2 ms)
    ✓ globSync absolute → absolute results
  opendir/Dir
    ✓ opendirSync + readSync iteration
    ✓ for-await auto-closes; further ops → ERR_DIR_CLOSED (1 ms)
  lutimes/statfs
    ✓ lutimesSync sets symlink times without touching target (1 ms)
    ✓ statfsSync keys include frsize (2 ms)
  misc APIs
    ✓ existsSync false for invalid paths, never throws (1 ms)
    ✓ mkdtempSync creates dir
    ✓ realpathSync.native exists (1 ms)
    ✓ FileReadStream/FileWriteStream aliases (1 ms)
    ✓ openAsBlob (1 ms)
    ✓ constants (1 ms)
    ✓ FileHandle not public (4 ms)
    ✓ lchmod/lchmodSync undefined on linux (1 ms)
  streams
    ✓ createWriteStream/createReadStream roundtrip (5 ms)
    ✓ autoClose:false keeps fd open (5 ms)
  watchers
    ✓ watchFile fires on change (201 ms)
    ✓ watch returns watcher with ref/unref (201 ms)
  runtime integration
    ✓ _vol is the real memfs Volume with toJSON/readFileSync (1 ms)
    ✓ _vol.toJSON contains written files (1 ms)
    ✓ emitMe receives fs events (1 ms)
    ✓ seeds from __USER_FILES__ (flat) (4 ms)

PASS tests/domain.test.js
  module shape (matches node:domain)
    ✓ create === createDomain (3 ms)
    ✓ exports Domain, active, _stack (1 ms)
    ✓ no dispose() upstream — the port does not add one (1 ms)
    ✓ Domain instances are EventEmitters with a members list (2 ms)
    ✓ setUncaughtExceptionCaptureCallback throws after load (2 ms)
  enter/exit/active/_stack
    ✓ stack push/pop shape (1 ms)
    ✓ active transitions: domain while entered, undefined after final exit (1 ms)
    ✓ exit() on a non-entered domain is a no-op
  run()
    ✓ returns the callback result and forwards arguments (1 ms)
    ✓ calls back with the domain as `this` (1 ms)
    ✓ active domain is set inside run and cleared after (1 ms)
  bind()
    ✓ forwards `this` and arguments, returns the result (1 ms)
    ✓ bound function carries a non-enumerable .domain
    ✓ throw inside bound function routes to the domain error handler (7 ms)
  intercept()
    ✓ passes through non-error calls with args/`this`/return (2 ms)
    ✓ routes Error first-args to the error handler with annotations (1 ms)
    ✓ non-Error first-arg is treated as data, not an error (1 ms)
  add()/remove()
    ✓ add assigns ee.domain (non-enumerable) and tracks members (1 ms)
    ✓ add is idempotent for the same domain (1 ms)
    ✓ add moves an emitter from another domain (1 ms)
    ✓ remove clears ee.domain to null and drops the member (2 ms)
    ✓ emitter errors are routed to the owning domain (1 ms)
  error routing
    ✓ throw inside run() reaches the domain error handler (11 ms)
    ✓ throw in a nextTick scheduled inside run() is routed (1 ms)
  implicit binding
    ✓ setTimeout scheduled while entered runs with the domain active (5 ms)
    ✓ setTimeout scheduled outside any domain stays unbound (6 ms)
    ✓ promise reactions created while entered observe the domain (1 ms)
    ✓ global timers are pristine when no domain is active (1 ms)
  explicit require-time behavior
    ✓ domain module exposes the documented API surface only (1 ms)
  browser fallback (no native delegation)
    ✓ module loads with the native bridge disabled (1 ms)
    ✓ core domain tracking works without natives (2 ms)
    ✓ run/bind/intercept work without natives (3 ms)
    ✓ explicit emitter errors route without natives (2 ms)
    ✓ implicit timer binding works without natives (8 ms)
    ✓ without uncaught capture, a synchronous throw propagates (browser semantic) (3 ms)
  differential vs real node:domain
    ✓ module shape and initial state (78 ms)
    ✓ enter/exit/active/process.domain/_stack tracking (75 ms)
    ✓ run/bind/intercept argument and this forwarding (73 ms)
    ✓ intercept error annotations (67 ms)
    ✓ error routing: throw in run with an error listener (65 ms)
    ✓ add/remove member bookkeeping (69 ms)
    ✓ implicit nextTick binding (71 ms)
    ✓ implicit setTimeout binding (83 ms)

(node:2396) [JEST-01] DeprecationWarning: 'active' property was accessed on [Object] after it was soft deleted
  Jest deletes objects that were set on the global scope between test files to reduce memory leaks.
  Currently it only "soft" deletes them and emits this warning if those objects were accessed after their deletion.
  In future versions of Jest, this behavior will change to "on", which will likely fail tests.
  Set `testEnvironmentOptions.globalsCleanup` to "on" to delete them now and reduce memory usage,
  or to "off" to disable the cleanup and this warning.
  See https://jestjs.io/docs/configuration#testenvironmentoptions-object
PASS tests/dgram.test.js
  dgram browser shim
    ✓ createSocket returns a Socket instance with the right type (4 ms)
    ✓ createSocket rejects bad socket types like Node (2 ms)
    ✓ createSocket accepts an options object (1 ms)
    ✓ createSocket validates buffer-size options like Node (2 ms)
    ✓ createSocket(type, listener) attaches a message listener (1 ms)
    ✓ bind() emits listening asynchronously and calls back (2 ms)
    ✓ bind() accepts (port, callback) shorthand (1 ms)
    ✓ bind() twice throws ERR_SOCKET_ALREADY_BOUND (1 ms)
    ✓ bind() on a closed socket throws ERR_SOCKET_DGRAM_NOT_RUNNING (1 ms)
    ✓ address() before bind throws EBADF like Node (1 ms)
    ✓ address() after bind returns null (no fabricated address) (1 ms)
    ✓ address() after close throws ERR_SOCKET_DGRAM_NOT_RUNNING (1 ms)
    ✓ send() validates the message like Node (1 ms)
    ✓ send() validates port and address like Node (2 ms)
    ✓ send() on a closed socket throws synchronously like Node (1 ms)
    ✓ send() discards the datagram: callback gets (null, 0) (2 ms)
    ✓ send() accepts a list of buffers and the offset/length form (1 ms)
    ✓ send() implicitly binds first: listening fires before the callback (1 ms)
    ✓ sendto() validates its numeric arguments (1 ms)
    ✓ connect() validates and emits connect asynchronously (1 ms)
    ✓ connect() twice throws ERR_SOCKET_DGRAM_IS_CONNECTED (1 ms)
    ✓ remoteAddress() throws when not connected, null when connected (1 ms)
    ✓ disconnect() works once, then throws (2 ms)
    ✓ send() with port/address while connected throws ERR_SOCKET_DGRAM_IS_CONNECTED (1 ms)
    ✓ close() emits close asynchronously and calls back (1 ms)
    ✓ close() twice throws ERR_SOCKET_DGRAM_NOT_RUNNING like Node (1 ms)
    ✓ close() while binding is queued instead of throwing (1 ms)
    ✓ Symbol.asyncDispose closes the socket (3 ms)
    ✓ TTL setters validate and return the value (1 ms)
    ✓ setMulticastInterface validates the address (1 ms)
    ✓ membership methods require an address, otherwise noop (1 ms)
    ✓ buffer-size setters validate; getters return 0 (no real buffers) (1 ms)
    ✓ ref()/unref() return the socket (1 ms)
    ✓ bindSync() validates like Node, emits listening, returns null address (1 ms)
    ✓ connectSync() validates like Node and emits connect (2 ms)
    ✓ options.signal aborts the socket (1 ms)
    ✓ options.signal rejects non-signals like Node
    ✓ default export exposes Socket and createSocket (1 ms)

FAIL tests/async_hooks.test.js
  export surface (both lanes)
    ✓ exports exactly the Node v24.20.0 surface, no default export (3 ms)
    ✓ export types
    ✕ asyncWrapProviders is the frozen v24.20.0 enum (2 ms)
  node lane (native delegation)
    ✓ delegates to the genuine builtin (1 ms)
    ✓ AsyncLocalStorage propagates across real async boundaries (6 ms)
    ✓ createHook observes real async resources (timers) (9 ms)
    ✓ executionAsyncId is a non-negative integer
  browser fallback (no native delegation)
    ✓ module loads with the native bridge disabled (1 ms)
    ✓ does not patch host globals (Promise / setTimeout / nextTick) (1 ms)
    ✓ asyncWrapProviders stub matches the real enum shape (3 ms)
    createHook
      ✓ validates callback types with ERR_ASYNC_CALLBACK (2 ms)
      ✓ validates trackPromises with ERR_INVALID_ARG_TYPE (1 ms)
      ✓ missing callbacks object throws a plain TypeError (like Node) (3 ms)
      ✓ enable()/disable() track state and are idempotent (1 ms)
      ✓ init/before/after/destroy fire for stub resources, in order (2 ms)
      ✓ a disabled hook receives nothing (1 ms)
    AsyncResource
      ✓ allocates unique async ids
      ✓ type is required to be a string (1 ms)
      ✓ triggerAsyncId defaults to the current execution id (1 ms)
      ✓ non-integer triggerAsyncId throws ERR_INVALID_ASYNC_ID
      ✓ runInAsyncScope sets and restores the execution id (1 ms)
      ✓ runInAsyncScope restores the id even when fn throws (1 ms)
      ✓ runInAsyncScope forwards thisArg and args (1 ms)
      ✓ emitDestroy is idempotent
      ✓ executionAsyncResource / triggerAsyncId follow the scope
      ✓ AsyncResource.bind runs fn in the resource scope (2 ms)
      ✓ AsyncResource.bind defaults anonymous functions to bound-anonymous-fn
    AsyncLocalStorage
      ✓ run sets the store synchronously and restores it (1 ms)
      ✓ nested run scopes do not interfere (1 ms)
      ✓ run restores the store when the callback throws (1 ms)
      ✓ run passes through extra args and return values
      ✓ run with a non-function callback throws TypeError (1 ms)
      ✓ DOCUMENTED LIMITATION: run does not propagate across awaits (6 ms)
      ✓ enterWith sets the ambient store; exit runs outside it (1 ms)
      ✓ disable makes getStore undefined, but run still works inside (1 ms)
      ✓ constructor name option and name getter (1 ms)
      ✓ static bind captures the current stores synchronously
      ✓ static snapshot runs a function within the captured stores (1 ms)
      ✓ withScope().run behaves like run with a fixed store (1 ms)

  ● export surface (both lanes) › asyncWrapProviders is the frozen v24.20.0 enum

    expect(received).toBe(expected) // Object.is equality

    Expected: 27
    Received: 26

      62 |     expect(Object.getPrototypeOf(ah.asyncWrapProviders)).toBe(null);
      63 |     expect(ah.asyncWrapProviders.NONE).toBe(0);
    > 64 |     expect(ah.asyncWrapProviders.PROMISE).toBe(27);
         |                                           ^
      65 |     expect(ah.asyncWrapProviders.TCPWRAP).toBe(40);
      66 |     expect(Object.keys(ah.asyncWrapProviders)).toHaveLength(68);
      67 |   });

      at Object.<anonymous> (tests/async_hooks.test.js:64:43)

FAIL tests/tls.test.js
  tls browser port — export surface
    ✕ named exports match real node:tls exactly (5 ms)
    ✓ default export carries the same surface (1 ms)
    ✓ TLSSocket is an EventEmitter (1 ms)
  tls browser port — static data (differential vs real Node)
    ✓ getCiphers() returns the real static cipher list (2 ms)
    ✓ constants match real Node (1 ms)
    ✓ rootCertificates is honestly empty (documented gap)
    ✓ getCACertificates()/getCertificateCompressionAlgorithms() are honestly empty (1 ms)
  tls browser port — convertALPNProtocols
    ✓ encodes protocols exactly like real Node (1 ms)
    ✓ accepts Uint8Array entries (1 ms)
    ✓ rejects over-long protocols like real Node (2 ms)
  tls browser port — checkServerIdentity (hostname matching)
    ✓ mirrors real Node verdicts (8 ms)
    ✓ null cert throws a plain TypeError like real Node (1 ms)
  tls browser port — TLSSocket
    ✓ fresh socket has honest initial state (1 ms)
    ✓ handshake-derived getters never fabricate (1 ms)
    ✓ setServername / renegotiate shapes (1 ms)
    ✓ socket option methods are chainable noops (1 ms)
    ✓ write/end/destroy behave like a stream (3 ms)
    ✓ destroy(err) emits error then close(true) (1 ms)
  tls browser port — connect()
    ✓ returns TLSSocket with encrypted=false, emits connect then secureConnect (4 ms)
    ✓ callback fires on secureConnect (async) (1 ms)
    ✓ supports port/host/callback and options forms (2 ms)
    ✓ never emits error for unreachable hosts (no real TCP)
    ✓ validates port like Node (2 ms)
    ✓ TLSSocket#connect keeps encrypted=true on direct construction (1 ms)
    ✓ servername option is picked up
  tls browser port — Server
    ✓ createServer returns a Server; listener wires to secureConnection (1 ms)
    ✓ listen/close chain and emit asynchronously (1 ms)
    ✓ address() is null; ticket keys are honestly null
    ✓ getConnections reports zero (1 ms)
  tls browser port — createSecureContext
    ✓ returns a SecureContext handle with the right shape (1 ms)
    ✓ _tls_common exports match real node:_tls_common (1 ms)
    ✓ _tls_wrap re-exports the real surface (1 ms)
  tls browser port — browser-fallback lane
    ✓ works with native builtins disabled and no host Buffer (2 ms)

  ● tls browser port — export surface › named exports match real node:tls exactly

    expect(received).toEqual(expected) // deep equality

    - Expected  - 1
    + Received  + 3

    @@ -10,10 +10,12 @@
        "TLSSocket",
        "checkServerIdentity",
        "connect",
        "convertALPNProtocols",
        "createSecureContext",
    -   "createSecurePair",
        "createServer",
    +   "getCACertificates",
    +   "getCertificateCompressionAlgorithms",
        "getCiphers",
        "rootCertificates",
    +   "setDefaultCACertificates",
      ]

      13 |     const shim = Object.keys(tlsNs).filter((k) => k !== 'default').sort();
      14 |     const real = Object.keys(realTls).sort();
    > 15 |     expect(shim).toEqual(real);
         |                  ^
      16 |   });
      17 |
      18 |   test('default export carries the same surface', () => {

      at Object.<anonymous> (tests/tls.test.js:15:18)

FAIL tests/tty.test.js
  tty surface
    ✓ named exports (2 ms)
    ✓ default export mirrors { isatty, ReadStream, WriteStream } (1 ms)
    ✓ no top-level getColorDepth/hasColors (they live on WriteStream.prototype) (1 ms)
    ✓ WriteStream.prototype.isTTY is false (honest browser value; Node uses true) (1 ms)
  isatty()
    ✓ isatty(-1) is false and never throws (1 ms)
    ✓ isatty(-100) is false and never throws (1 ms)
    ✓ isatty(1.5) is false and never throws
    ✓ isatty("x") is false and never throws (1 ms)
    ✓ isatty("") is false and never throws
    ✓ isatty(NaN) is false and never throws
    ✓ isatty(null) is false and never throws (1 ms)
    ✓ isatty(undefined) is false and never throws (1 ms)
    ✓ isatty(true) is false and never throws
    ✓ isatty({}) is false and never throws (1 ms)
    ✓ isatty(2147483648) is false and never throws (1 ms)
    ✓ isatty(1099511627776) is false and never throws (1 ms)
    ✓ matches real node:tty on non-TTY inputs (1 ms)
  constructor fd validation
    ✓ new WriteStream(-1) throws ERR_INVALID_FD (1 ms)
    ✓ new WriteStream(1.5) throws ERR_INVALID_FD (1 ms)
    ✓ new WriteStream("1") throws ERR_INVALID_FD
    ✓ new WriteStream(NaN) throws ERR_INVALID_FD
    ✓ new WriteStream(undefined) throws ERR_INVALID_FD (1 ms)
    ✓ new WriteStream(1e+21) throws ERR_INVALID_FD (1 ms)
    ✓ new ReadStream(-1) throws ERR_INVALID_FD (1 ms)
    ✓ new ReadStream(1.5) throws ERR_INVALID_FD
    ✓ new ReadStream("1") throws ERR_INVALID_FD (1 ms)
    ✓ new ReadStream(NaN) throws ERR_INVALID_FD
    ✓ new ReadStream(undefined) throws ERR_INVALID_FD
    ✓ new ReadStream(1e+21) throws ERR_INVALID_FD (1 ms)
    ✓ invalid fd without new also throws (4 ms)
    ✓ closed/invalid non-negative fd throws ERR_TTY_INIT_FAILED (real Node parity) (1 ms)
    ✓ callable without new (1 ms)
  ReadStream
    ✓ starts non-raw and non-TTY (1 ms)
    ✓ setRawMode(true) coerces with !! and returns this (no validation, like Node)
    ✓ setRawMode(false) coerces with !! and returns this (no validation, like Node) (1 ms)
    ✓ setRawMode(1) coerces with !! and returns this (no validation, like Node)
    ✓ setRawMode(0) coerces with !! and returns this (no validation, like Node) (1 ms)
    ✓ setRawMode("x") coerces with !! and returns this (no validation, like Node)
    ✓ setRawMode("") coerces with !! and returns this (no validation, like Node) (1 ms)
    ✓ setRawMode(undefined) coerces with !! and returns this (no validation, like Node)
    ✓ setRawMode(null) coerces with !! and returns this (no validation, like Node) (1 ms)
    ✓ setRawMode({}) coerces with !! and returns this (no validation, like Node)
    ✓ setRawMode(NaN) coerces with !! and returns this (no validation, like Node)
  WriteStream basics
    ✓ isTTY false, 80x24 fallback size (1 ms)
    ✓ _refreshSize exists and is a safe noop
  ANSI cursor methods (delegate to readline, like Node)
    ✓ cursorTo writes \x1b[{y+1};{x+1}H
    ✓ cursorTo without y writes \x1b[{x+1}G
    ✓ moveCursor writes relative sequences (1 ms)
    ✓ moveCursor(0,0) writes nothing but returns true
    ✓ clearLine(0) writes ""
    ✓ clearLine(1) writes ""
    ✓ clearLine(-1) writes "" (1 ms)
    ✓ clearScreenDown writes \x1b[0J (3 ms)
    ✓ callbacks are invoked (1 ms)
    ✓ cursorTo(NaN) throws ERR_INVALID_ARG_VALUE (2 ms)
    ✓ non-function callback throws ERR_INVALID_ARG_TYPE
    ✓ byte output matches real node:tty + node:readline (2 ms)
  getColorDepth()
    ✓ getColorDepth({}) === 1 (1 ms)
    ✓ getColorDepth({"FORCE_COLOR": "1"}) === 4 (1 ms)
    ✓ getColorDepth({"FORCE_COLOR": ""}) === 4
    ✓ getColorDepth({"FORCE_COLOR": "true"}) === 4 (1 ms)
    ✓ getColorDepth({"FORCE_COLOR": "2"}) === 8
    ✓ getColorDepth({"FORCE_COLOR": "3"}) === 24 (1 ms)
    ✓ getColorDepth({"FORCE_COLOR": "0"}) === 1
    ✓ getColorDepth({"FORCE_COLOR": "banana"}) === 1 (1 ms)
    ✓ getColorDepth({"NODE_DISABLE_COLORS": "1"}) === 1
    ✓ getColorDepth({"NO_COLOR": "1"}) === 1 (1 ms)
    ✓ getColorDepth({"TERM": "dumb"}) === 1
    ✓ getColorDepth({"TERM": "xterm-256color"}) === 8
    ✓ getColorDepth({"TERM": "xterm"}) === 4 (1 ms)
    ✓ getColorDepth({"TERM": "screen"}) === 4 (1 ms)
    ✓ getColorDepth({"TERM": "rxvt-unicode"}) === 4
    ✓ getColorDepth({"TERM": "linux"}) === 4 (1 ms)
    ✓ getColorDepth({"TERM": "ansi"}) === 4 (1 ms)
    ✓ getColorDepth({"TERM": "vt100"}) === 4 (1 ms)
    ✓ getColorDepth({"TERM": "putty"}) === 4
    ✓ getColorDepth({"TERM": "mosh"}) === 24 (1 ms)
    ✕ getColorDepth({"TERM": "xterm-kitty"}) === 24 (1 ms)
    ✕ getColorDepth({"TERM": "XTERM-KITTY"}) === 24
    ✕ getColorDepth({"TERM": "xterm-truecolor"}) === 24
    ✓ getColorDepth({"COLORTERM": "truecolor"}) === 24
    ✓ getColorDepth({"COLORTERM": "24bit"}) === 24 (1 ms)
    ✓ getColorDepth({"COLORTERM": "1"}) === 4
    ✓ getColorDepth({"TERM_PROGRAM": "iTerm.app"}) === 8 (1 ms)
    ✓ getColorDepth({"TERM_PROGRAM": "iTerm.app", "TERM_PROGRAM_VERSION": "2.9"}) === 8
    ✓ getColorDepth({"TERM_PROGRAM": "iTerm.app", "TERM_PROGRAM_VERSION": "3.4"}) === 24
    ✓ getColorDepth({"TERM_PROGRAM": "HyperTerm"}) === 24
    ✓ getColorDepth({"TERM_PROGRAM": "Apple_Terminal"}) === 8 (1 ms)
    ✕ getColorDepth({"TMUX": "1"}) === 24
    ✓ getColorDepth({"CI": "true"}) === 1
    ✕ getColorDepth({"CI": "true", "GITHUB_ACTIONS": "true"}) === 24 (1 ms)
    ✓ getColorDepth({"CI": "true", "TRAVIS": "1"}) === 8 (1 ms)
    ✓ getColorDepth({"CI": "true", "CI_NAME": "codeship"}) === 8 (1 ms)
    ✕ getColorDepth({"AGENT_NAME": "x", "TF_BUILD": "1"}) === 4
    ✓ getColorDepth({"TEAMCITY_VERSION": "9.1.1"}) === 4
    ✓ getColorDepth({"TEAMCITY_VERSION": "10.0"}) === 4 (1 ms)
    ✓ getColorDepth({"TEAMCITY_VERSION": "8.0"}) === 1
    ✓ null env throws TypeError like Node
  hasColors()
    ✓ hasColors(16, {}) === false (1 ms)
    ✓ hasColors(16, {"TERM": "xterm-256color"}) === true
    ✓ hasColors(256, {"TERM": "xterm-256color"}) === true (1 ms)
    ✓ hasColors(257, {"TERM": "xterm-256color"}) === false
    ✓ hasColors(16777216, {"FORCE_COLOR": "3"}) === true
    ✓ hasColors(16777217, {"FORCE_COLOR": "3"}) === false (1 ms)
    ✓ env-shifting forms (1 ms)
    ✓ hasColors(1) throws ERR_OUT_OF_RANGE (1 ms)
    ✓ hasColors(1.5) throws ERR_OUT_OF_RANGE (1 ms)
    ✓ hasColors("x") throws ERR_INVALID_ARG_TYPE (1 ms)
    ✓ hasColors(true) throws ERR_INVALID_ARG_TYPE (1 ms)
    ✓ hasColors(null) throws ERR_INVALID_ARG_TYPE
    ✓ hasColors(9007199254740992) throws ERR_OUT_OF_RANGE (1 ms)
  tty browser fallback (no native delegation)
    ✓ module loads and constructs streams (1 ms)
    ✓ isatty() is always false (1 ms)
    ✓ fd validation still throws without natives (1 ms)
    ✓ bad fd does not throw without the native probe (no OS fds in browser)
    ✓ ANSI methods still write correct escape bytes (1 ms)
    ✕ honest platform color values (1 ms)

  ● getColorDepth() › getColorDepth({"TERM": "xterm-kitty"}) === 24

    expect(received).toBe(expected) // Object.is equality

    Expected: 4
    Received: 24

      361 |     // and it matches real node:tty exactly
      362 |     const r = new realTty.WriteStream(1);
    > 363 |     expect(s.getColorDepth({ ...env })).toBe(r.getColorDepth({ ...env }));
          |                                         ^
      364 |     s.destroy();
      365 |     r.destroy();
      366 |   });

      at tests/tty.test.js:363:41

  ● getColorDepth() › getColorDepth({"TERM": "XTERM-KITTY"}) === 24

    expect(received).toBe(expected) // Object.is equality

    Expected: 4
    Received: 24

      361 |     // and it matches real node:tty exactly
      362 |     const r = new realTty.WriteStream(1);
    > 363 |     expect(s.getColorDepth({ ...env })).toBe(r.getColorDepth({ ...env }));
          |                                         ^
      364 |     s.destroy();
      365 |     r.destroy();
      366 |   });

      at tests/tty.test.js:363:41

  ● getColorDepth() › getColorDepth({"TERM": "xterm-truecolor"}) === 24

    expect(received).toBe(expected) // Object.is equality

    Expected: 4
    Received: 24

      361 |     // and it matches real node:tty exactly
      362 |     const r = new realTty.WriteStream(1);
    > 363 |     expect(s.getColorDepth({ ...env })).toBe(r.getColorDepth({ ...env }));
          |                                         ^
      364 |     s.destroy();
      365 |     r.destroy();
      366 |   });

      at tests/tty.test.js:363:41

  ● getColorDepth() › getColorDepth({"TMUX": "1"}) === 24

    expect(received).toBe(expected) // Object.is equality

    Expected: 8
    Received: 24

      361 |     // and it matches real node:tty exactly
      362 |     const r = new realTty.WriteStream(1);
    > 363 |     expect(s.getColorDepth({ ...env })).toBe(r.getColorDepth({ ...env }));
          |                                         ^
      364 |     s.destroy();
      365 |     r.destroy();
      366 |   });

      at tests/tty.test.js:363:41

  ● getColorDepth() › getColorDepth({"CI": "true", "GITHUB_ACTIONS": "true"}) === 24

    expect(received).toBe(expected) // Object.is equality

    Expected: 8
    Received: 24

      361 |     // and it matches real node:tty exactly
      362 |     const r = new realTty.WriteStream(1);
    > 363 |     expect(s.getColorDepth({ ...env })).toBe(r.getColorDepth({ ...env }));
          |                                         ^
      364 |     s.destroy();
      365 |     r.destroy();
      366 |   });

      at tests/tty.test.js:363:41

  ● getColorDepth() › getColorDepth({"AGENT_NAME": "x", "TF_BUILD": "1"}) === 4

    expect(received).toBe(expected) // Object.is equality

    Expected: 1
    Received: 4

      361 |     // and it matches real node:tty exactly
      362 |     const r = new realTty.WriteStream(1);
    > 363 |     expect(s.getColorDepth({ ...env })).toBe(r.getColorDepth({ ...env }));
          |                                         ^
      364 |     s.destroy();
      365 |     r.destroy();
      366 |   });

      at tests/tty.test.js:363:41

  ● tty browser fallback (no native delegation) › honest platform color values

    expect(received).toBe(expected) // Object.is equality

    Expected: false
    Received: true

      497 |     const w = new fb.WriteStream(1);
      498 |     expect(w.getColorDepth({})).toBe(1);
    > 499 |     expect(w.hasColors()).toBe(false);
          |                           ^
      500 |     w.destroy();
      501 |   });
      502 | });

      at Object.<anonymous> (tests/tty.test.js:499:27)

FAIL tests/perf_hooks.test.js
  perf_hooks module surface
    ✕ exports match Node v24.20.0 (no Histogram) (8 ms)
    ✓ performance.timerify is the exported timerify (1 ms)
    ✓ performance.eventLoopUtilization is the exported eventLoopUtilization
    ✓ constants are frozen with expected values (1 ms)
    ✓ Performance constructor throws (2 ms)
  performance marks and measures
    ✓ mark creates a PerformanceMark entry (6 ms)
    ✓ mark with explicit startTime (1 ms)
    ✓ mark rejects negative startTime (2 ms)
    ✓ measure(name, startMark) uses now() - start (1 ms)
    ✓ measure(name, startMark, endMark)
    ✓ measure with { start: markName } resolves the mark (1 ms)
    ✓ measure with { end: number } starts at 0 (1 ms)
    ✓ measure with { start, duration } (1 ms)
    ✓ measure with { end, duration } derives start (1 ms)
    ✓ measure with all three options throws (1 ms)
    ✓ measure with missing mark throws DOMException SyntaxError (1 ms)
    ✓ measure with numeric start does not do a mark lookup (1 ms)
    ✓ clearMeasures does not clear marks (1 ms)
    ✓ getEntriesByName / getEntriesByType filter (1 ms)
  PerformanceObserver
    ✓ delivers entries asynchronously and filters by entryTypes (2 ms)
    ✓ disconnect allows re-observe (1 ms)
    ✓ takeRecords works after disconnect
    ✓ entry list supports getEntriesByType/getEntriesByName (1 ms)
  resource timing (pure JS)
    ✓ maps timingInfo fields to getters (verified vs Node) (3 ms)
    ✓ toJSON key order matches Node (1 ms)
    ✓ null finalConnectionTimingInfo yields undefined connection getters (1 ms)
    ✓ transferSize depends on cacheMode
    ✓ resource entries are buffered and retrievable (1 ms)
  histograms (pure JS)
    ✓ empty histogram matches Node (3 ms)
    ✓ record values and statistics (Node-verified) (2 ms)
    ✓ bucket quantization matches Node (figures:1) (1 ms)
    ✓ record validation (5 ms)
    ✓ reset clears the histogram (1 ms)
    ✓ percentiles map matches Node (2 ms)
  timerify (pure JS)
    ✓ wraps sync functions and records entries (4 ms)
    ✓ does not mutate the original function name (1 ms)
    ✓ validates arguments
  browser-fallback approximations
    ✓ eventLoopUtilization returns zero shape without libuv
    ✓ nodeTiming reports loopStart/loopExit as -1 without libuv
    ✓ monitorEventLoopDelay starts disabled and samples (52 ms)

  ● perf_hooks module surface › exports match Node v24.20.0 (no Histogram)

    expect(received).toEqual(expected) // deep equality

    - Expected  - 2
    + Received  + 0

    @@ -6,10 +6,8 @@
        "PerformanceObserver",
        "PerformanceObserverEntryList",
        "PerformanceResourceTiming",
        "constants",
        "createHistogram",
    -   "eventLoopUtilization",
        "monitorEventLoopDelay",
        "performance",
    -   "timerify",
      ]

      54 |     // The native namespace additionally carries a `default` key; the named
      55 |     // exports must otherwise match.
    > 56 |     expect(Object.keys(nativePerfHooks).filter((k) => k !== 'default').sort()).toEqual(
         |                                                                                ^
      57 |       expected.slice().sort(),
      58 |     );
      59 |     for (const name of expected) {

      at Object.<anonymous> (tests/perf_hooks.test.js:56:80)

PASS tests/sqlite.test.js
  module shape
    ✓ named exports exist (2 ms)
    ✓ default export carries the named exports (CJS require interop)
    ✓ DatabaseSync has the full Node v24 method surface (1 ms)
    ✓ StatementSync has the full Node v24 method surface (1 ms)
    ✓ Session has the full Node v24 method surface (1 ms)
    ✓ constants match Node v24.20.0 values (spot check) (1 ms)
    ✓ toString tags match real Node ([object Object]) (1 ms)
  DatabaseSync constructor
    ✓ requires a path (Node-identical TypeError) (4 ms)
    ✓ accepts string, Uint8Array, URL paths (1 ms)
    ✓ options must be an object; boolean options are validated (3 ms)
    ✓ unknown options are ignored (like Node) (5 ms)
    ✓ open defaults to true; open:false stays closed without opening anything (1 ms)
    ✓ isTransaction is false; limits carry SQLite defaults (1 ms)
    ✓ location() echoes the path, null for :memory:
  open/close lifecycle mirrors Node
    ✓ close() then open() then close() (1 ms)
    ✓ Symbol.dispose closes an open database, noops when closed (1 ms)
    ✓ engine methods on a closed db throw ERR_INVALID_STATE (not unavailable) (1 ms)
  data methods throw the documented unavailable error
    ✓ exec() validates args, then throws unavailable (never pretends to run) (1 ms)
    ✓ prepare() returns a StatementSync shape; SQL text getters work (1 ms)
    ✓ statement data methods throw unavailable, never fake rows (2 ms)
    ✓ statement config setters throw unavailable
    ✓ statements are finalized when the db closes (Node-identical state error)
    ✓ direct construction of StatementSync/Session is illegal (like Node) (2 ms)
    ✓ calling DatabaseSync without new throws ERR_CONSTRUCT_CALL_REQUIRED (1 ms)
    ✓ instances carry the sqlite-type symbol tag
    ✓ statement/data option flags are boolean-validated (1 ms)
    ✓ engine config methods throw unavailable after validation (2 ms)
    ✓ createSession returns a Session shape; changeset/patchset throw unavailable (2 ms)
    ✓ applyChangeset validates, then throws unavailable (3 ms)
    ✓ backup() validates args, then throws unavailable (never a fake backup) (1 ms)
  browser fallback (no native delegation)
    ✓ module loads with no native builtins (1 ms)
    ✓ constructor validation works without natives (1 ms)
    ✓ backup validates and throws unavailable without natives

PASS tests/vm.test.js
  vm shim
    synchronous return values
      ✓ runInNewContext returns the completion value directly (3 ms)
      ✓ runInContext returns the completion value directly
      ✓ runInThisContext returns the completion value directly (1 ms)
      ✓ Script methods return values directly (1 ms)
      ✓ errors are thrown synchronously (3 ms)
    createContext / isContext
      ✓ createContext returns the same object and is idempotent
      ✓ isContext is false for plain objects (1 ms)
      ✓ isContext throws for non-objects (1 ms)
      ✓ createContext validates its arguments (2 ms)
      ✓ DONT_CONTEXTIFY creates a fresh context
      ✓ runInContext requires a contextified object (1 ms)
    sandbox global semantics
      ✓ bare assignments land on the context object (1 ms)
      ✓ var declarations land on the context object (1 ms)
      ✓ function declarations land on the context and keep identity
      ✓ let/const do not leak onto the context
      ✓ reads of undeclared names throw ReferenceError (1 ms)
      ✓ delete on var-declared names is false (non-configurable)
      ✓ this and globalThis at the top level are the context object (1 ms)
      ✓ host globals are not visible or polluted (1 ms)
      ✓ standard globals are available (1 ms)
      ✓ strict mode scripts work (1 ms)
    Script
      ✓ stringifies non-string code (1 ms)
      ✓ accepts a filename string as options
      ✓ runInContext string options are converted to filename
      ✓ Script run-method options reject non-objects (1 ms)
      ✓ cachedData round-trip: matching source is not rejected (2 ms)
    compileFunction
      ✓ compiles and runs with params
      ✓ params may be omitted
      ✓ contextExtensions are visible
      ✓ parsingContext is used as the scope (1 ms)
      ✓ undeclared names throw ReferenceError (4 ms)
      ✓ validates arguments with Node error codes (2 ms)
      ✓ stack traces map to the compiled source
    error enrichment
      ✓ stack contains filename, line, column and source context (1 ms)
    differential validation vs node:vm
      ✓ createContext null throws the same code as node:vm (1 ms)
      ✓ createContext array opts throws the same code as node:vm (1 ms)
      ✓ isContext null throws the same code as node:vm
      ✓ runInContext plain object throws the same code as node:vm
      ✓ compileFunction bad code throws the same code as node:vm
      ✓ compileFunction bad params throws the same code as node:vm
      ✓ runInNewContext bad microtask throws the same code as node:vm (1 ms)
      ✓ timeout zero throws the same code as node:vm (1 ms)
    misc API
      ✓ constants are frozen and expose both symbols
      ✓ measureMemory resolves a summary shape (1 ms)
      ✓ ESM module classes are not exported (matches Node without --experimental-vm-modules)
      ✓ default export exposes the full API (1 ms)

PASS tests/readline.test.js
  module shape
    ✓ exports exactly the Node callback API (2 ms)
    ✓ has no Readline export (unlike readline/promises)
    ✓ named exports match the default export (2 ms)
    ✓ does not pollute the global scope
  readline (callback version)
    createInterface()
      ✓ returns an Interface instance (2 ms)
      ✓ Interface is callable without new
      ✓ accepts positional arguments
      ✓ throws ERR_INVALID_ARG_VALUE for non-function completer (4 ms)
      ✓ throws ERR_INVALID_ARG_TYPE for non-array history
    Interface
      ✓ emits 'line' event for each line (2 ms)
      ✓ splits CR, LF, CRLF, U+2028 and U+2029 line endings (1 ms)
      ✓ handles EOF without trailing newline (1 ms)
      ✓ emits 'close' after input ends (1 ms)
      ✓ close() emits close event and is idempotent (1 ms)
      ✓ question() invokes callback with answer (1 ms)
      ✓ question() writes prompt to output (1 ms)
      ✓ question() is promisifiable via util.promisify
      ✓ question() with aborted signal invokes no callback (2 ms)
      ✓ pause() and resume() do not throw (1 ms)
      ✓ pause() emits 'pause' event
      ✓ resume() emits 'resume' event (1 ms)
      ✓ pause()/write() after close throw ERR_USE_AFTER_CLOSE (1 ms)
      ✓ setPrompt() / getPrompt()
      ✓ getCursorPos() reflects prompt width (1 ms)
      ✓ terminal is false without a TTY output
      ✓ line starts as empty string (1 ms)
      ✓ cursor is undefined in non-terminal mode (matches Node)
      ✓ cursor is 0 in terminal mode (4 ms)
      ✓ history defaults to [] with historySize 30
      ✓ async iterator yields lines (2 ms)
    ANSI helpers
      ✓ cursorTo writes absolute column sequence (1 ms)
      ✓ cursorTo writes row/col sequence
      ✓ moveCursor writes relative sequences
      ✓ moveCursor(0, 0) writes nothing (1 ms)
      ✓ clearLine writes erase sequences
      ✓ clearScreenDown writes erase-below sequence (1 ms)
      ✓ null stream returns true and fires callback async (1 ms)
      ✓ cursorTo validates arguments like Node (1 ms)
    emitKeypressEvents
      ✓ decodes keypress events with Node key shapes (2 ms)

PASS tests/sea.test.js
  sea without a virtual asset store (absent __SEA_ASSETS__)
    export surface matches node:sea
      ✓ named exports are exactly the five Node functions (3 ms)
      ✓ default export exposes the same five functions (1 ms)
      ✓ has no injectAsset escape hatch (injection is host-side, not a module export) (1 ms)
    isSea()
      ✓ returns false (1 ms)
      ✓ ignores extra arguments like real Node (1 ms)
      ✓ stays false across calls (no hidden state) (1 ms)
    getters return empty values instead of throwing
      ✓ getRawAsset returns undefined for any string key (1 ms)
      ✓ getAsset returns undefined with and without encoding (1 ms)
      ✓ getAssetAsBlob returns undefined (never fabricates a Blob) (2 ms)
      ✓ getAssetKeys returns an empty array (2 ms)
      ✓ getAssetKeys returns a fresh array each call (5 ms)
    argument validation (ERR_INVALID_ARG_TYPE, Node-exact)
      ✓ getRawAsset(1) throws ERR_INVALID_ARG_TYPE (5 ms)
      ✓ getRawAsset(1n) throws ERR_INVALID_ARG_TYPE (2 ms)
      ✓ getRawAsset(Symbol(s)) throws ERR_INVALID_ARG_TYPE (2 ms)
      ✓ getRawAsset(false) throws ERR_INVALID_ARG_TYPE (2 ms)
      ✓ getRawAsset(null) throws ERR_INVALID_ARG_TYPE (2 ms)
      ✓ getRawAsset(undefined) throws ERR_INVALID_ARG_TYPE (2 ms)
      ✓ getRawAsset({}) throws ERR_INVALID_ARG_TYPE (2 ms)
      ✓ getRawAsset([]) throws ERR_INVALID_ARG_TYPE (1 ms)
      ✓ getAsset(1) throws ERR_INVALID_ARG_TYPE (1 ms)
      ✓ getAsset(1n) throws ERR_INVALID_ARG_TYPE (2 ms)
      ✓ getAsset(Symbol(s)) throws ERR_INVALID_ARG_TYPE (2 ms)
      ✓ getAsset(false) throws ERR_INVALID_ARG_TYPE (1 ms)
      ✓ getAsset(null) throws ERR_INVALID_ARG_TYPE (2 ms)
      ✓ getAsset(undefined) throws ERR_INVALID_ARG_TYPE (1 ms)
      ✓ getAsset({}) throws ERR_INVALID_ARG_TYPE (2 ms)
      ✓ getAsset([]) throws ERR_INVALID_ARG_TYPE (1 ms)
      ✓ getAssetAsBlob(1) throws ERR_INVALID_ARG_TYPE (2 ms)
      ✓ getAssetAsBlob(1n) throws ERR_INVALID_ARG_TYPE (1 ms)
      ✓ getAssetAsBlob(Symbol(s)) throws ERR_INVALID_ARG_TYPE (2 ms)
      ✓ getAssetAsBlob(false) throws ERR_INVALID_ARG_TYPE (1 ms)
      ✓ getAssetAsBlob(null) throws ERR_INVALID_ARG_TYPE (4 ms)
      ✓ getAssetAsBlob(undefined) throws ERR_INVALID_ARG_TYPE (2 ms)
      ✓ getAssetAsBlob({}) throws ERR_INVALID_ARG_TYPE (1 ms)
      ✓ getAssetAsBlob([]) throws ERR_INVALID_ARG_TYPE (2 ms)
      ✓ getAsset("k", 1) throws ERR_INVALID_ARG_TYPE for encoding (1 ms)
      ✓ getAsset("k", 1n) throws ERR_INVALID_ARG_TYPE for encoding (1 ms)
      ✓ getAsset("k", Symbol(e)) throws ERR_INVALID_ARG_TYPE for encoding (1 ms)
      ✓ getAsset("k", false) throws ERR_INVALID_ARG_TYPE for encoding (2 ms)
      ✓ getAsset("k", null) throws ERR_INVALID_ARG_TYPE for encoding (2 ms)
      ✓ getAsset("k", {}) throws ERR_INVALID_ARG_TYPE for encoding (1 ms)
      ✓ getAsset("k", []) throws ERR_INVALID_ARG_TYPE for encoding (2 ms)
      ✓ error messages match real Node rendering (2 ms)
      ✓ getAssetAsBlob does not validate options when not in SEA (matches real Node) (2 ms)
  sea with a virtual asset store (__SEA_ASSETS__ present)
    isSea()
      ✓ returns true when the store holds assets (1 ms)
      ✓ returns false when the store is removed at runtime (1 ms)
      ✓ returns false for a present-but-empty store (2 ms)
      ✓ returns false when __SEA_ASSETS__ is not an object (1 ms)
    getAssetKeys()
      ✓ lists the embedded keys (1 ms)
      ✓ returns a fresh array each call (1 ms)
    getAsset() round-trip
      ✓ returns the raw bytes as a Uint8Array (1 ms)
      ✓ returns binary assets byte-identical (2 ms)
      ✓ returns a fresh copy on every call (1 ms)
      ✓ missing key returns undefined (1 ms)
      ✓ decodes with utf8 / utf-8 (3 ms)
      ✓ decodes binary asset to base64 and hex (1 ms)
      ✓ unknown encoding throws ERR_UNKNOWN_ENCODING (2 ms)
    getRawAsset()
      ✓ returns an ArrayBuffer with the asset bytes (1 ms)
      ✓ returns a fresh copy each call (1 ms)
      ✓ missing key returns undefined (2 ms)
    getAssetAsBlob()
      ✓ returns a Blob with the asset bytes (2 ms)
      ✓ honors options.type without validating options (2 ms)
      ✓ missing key returns undefined (2 ms)
    lenient host-assigned entry shapes
      ✓ plain string entries read as utf8 (2 ms)
      ✓ Uint8Array entries read as raw bytes (1 ms)
      ✓ malformed entries read as undefined but keep their key listed (2 ms)
    argument validation still enforced with a store present
      ✓ invalid keys throw ERR_INVALID_ARG_TYPE (4 ms)
      ✓ invalid encoding throws ERR_INVALID_ARG_TYPE (1 ms)

PASS tests/worker_threads.test.js
  worker_threads browser implementation (native bridge disabled)
    ✓ identifies as main thread with null workerData/parentPort (3 ms)
    ✓ environment data store round-trips and deletes (1 ms)
    ✓ eval worker round-trips workerData and reports exit 0 (2 ms)
    ✓ threadId, threadName and workerData propagate through the handshake (1 ms)
    ✓ main -> worker messaging via parentPort.on("message") (2 ms)
    ✓ terminate() stops the worker and resolves the exit code (2 ms)
    ✓ uncaught worker error emits error and exits 1 (1 ms)
    ✓ constructor validates filename (3 ms)
    ✓ stdio is null and heap introspection is an honest noop (2 ms)
    ✓ markAsUntransferable blocks transferList entries (2 ms)
    ✓ markAsUncloneable blocks the message value (2 ms)
    ✓ MessageChannel/MessagePort round-trip and receiveMessageOnPort drains (21 ms)
    ✓ moveMessagePortToContext is a pass-through noop (1 ms)
    ✓ postMessageToThread rejects for the current thread (1 ms)
    ✓ locks shim serializes exclusive access (31 ms)
    ✓ default export exposes the full module shape (1 ms)
    ✓ native bridge is genuinely disabled in this file

(node:2402) [DEP0141] DeprecationWarning: repl.inputStream and repl.outputStream are deprecated. Use repl.input and repl.output instead.
PASS tests/repl.test.js
  repl export surface
    ✓ named and default exports exist (2 ms)
    ✓ isValidSyntax
    ✓ Recoverable is a SyntaxError subclass (1 ms)
  basic evaluation over streams
    ✓ 1+1 evaluates to 2 with a synchronous initial prompt (27 ms)
    ✓ statements, var, and function declarations persist across evals (87 ms)
    ✓ let and const bindings persist across evals (85 ms)
    ✓ custom writer is used for results (22 ms)
    ✓ _ holds the last result and r.last tracks it (43 ms)
    ✓ runtime errors print as Uncaught (47 ms)
    ✓ ignoreUndefined suppresses undefined results (93 ms)
  multiline / recoverable input
    ✓ incomplete input buffers and prompts with "| " (84 ms)
    ✓ .break discards the buffered command (43 ms)
  dot commands
    ✓ .exit closes the repl and emits exit (21 ms)
    ✓ .help lists the default commands (22 ms)
    ✓ defineCommand registers a custom command (22 ms)
    ✓ defineCommand with a bare function works too (22 ms)
    ✓ defineCommand validates the action (3 ms)
    ✓ unknown command prints Invalid REPL keyword (21 ms)
    ✓ .clear resets the context (63 ms)
  modes and options
    ✓ strict mode prefixes code (22 ms)
    ✓ useGlobal evaluates on globalThis (22 ms)
    ✓ breakEvalOnSigint with a custom eval is rejected (1 ms)
    ✓ inputStream/outputStream alias input/output (2 ms)
    ✓ _domain exposes on/emit/bind (1 ms)
    ✓ custom eval functions are supported (51 ms)
  top-level await
    ✓ awaited expressions resolve to their value (28 ms)
    ✓ let declarations with await persist across evals (43 ms)
    ✓ TLA declarations/functions/classes persist (useGlobal: false) (24 ms)
    ✓ TLA declarations/functions/classes persist (useGlobal: true) (6 ms)
    ✓ .clear resets TLA lexical bindings (3 ms)
  completion
    ✓ completer suggests context names (22 ms)
  browser fallback (no runtime terminal)
    ✓ works with plain in-memory streams and no _RUNTIME_ (53 ms)
    ✓ falls back to a null stream when no streams are available (1 ms)

PASS tests/dns.test.js
  dns (DoH shim)
    ✓ named exports match node:dns surface (17 ms)
    ✓ require('dns/promises') === dns.promises (namespace identity) (1 ms)
    ✓ error-code constants match c-ares names (2 ms)
    ✓ default servers are DoH endpoints (3 ms)
    ✓ setServers/getServers round-trip (10 ms)
    ✓ setServers validation mirrors Node (17 ms)
    ✓ setServers normalizes addresses like Node (4 ms)
    ✓ setServers skips holes (1 ms)
    ✓ setServers: module-level never throws for pending queries, Resolver does (384 ms)
    ✓ getDefaultResultOrder/setDefaultResultOrder (5 ms)
    ✓ lookup validation (9 ms)
    ✓ callbacks are always async (54 ms)
    lookup()
      ✓ resolves A and AAAA with all:true (11 ms)
      ✓ family filters record types (8 ms)
      ✓ literal IPs resolve locally, family ignored (matches Node) (2 ms)
      ✓ localhost resolves like getaddrinfo (2 ms)
      ✓ NXDOMAIN → ENOTFOUND with syscall getaddrinfo (8 ms)
      ✓ verbatim:false puts IPv4 first (7 ms)
    argument validation (matches Node v24)
      ✓ lookup: falsy hostnames resolve { address: null, family: 4 } (DEP0118) (3 ms)
      ✓ lookup: truthy non-string hostnames throw ERR_INVALID_ARG_TYPE (4 ms)
      ✓ lookup: embedded NUL throws ERR_INVALID_ARG_VALUE (2 ms)
      ✓ lookup: hints bitmask validation (7 ms)
      ✓ lookup: order validation (2 ms)
      ✓ lookup: family accepts IPv4/IPv6 strings, rejects the rest (3 ms)
      ✓ resolve: non-string rrtype → ERR_INVALID_ARG_TYPE, unknown string → ERR_INVALID_ARG_VALUE (1 ms)
      ✓ lookupService: missing-args messages match Node (3 ms)
    resolve* record shapes
      ✓ resolve4 (3 ms)
      ✓ resolve4 with { ttl: true } (3 ms)
      ✓ resolve6 (6 ms)
      ✓ resolveMx (3 ms)
      ✓ resolveTxt splits quoted strings (3 ms)
      ✓ resolveSrv (2 ms)
      ✓ resolveSoa (3 ms)
      ✓ resolveCaa (2 ms)
      ✓ resolveNaptr (2 ms)
      ✓ resolveTlsa (2 ms)
      ✓ resolveCname (1 ms)
      ✓ A query follows CNAME chains (3 ms)
      ✓ resolvePtr (1 ms)
      ✓ resolve defaults rrtype to A (2 ms)
      ✓ resolve dispatches rrtype (1 ms)
      ✓ resolve rejects invalid rrtype (lowercase included) (1 ms)
      ✓ resolveAny is ENOTIMP like real Node (c-ares deprecated ANY) (1 ms)
      ✓ NXDOMAIN → ENOTFOUND with query syscall (2 ms)
      ✓ NOERROR with no answers → ENODATA (2 ms)
      ✓ SERVFAIL → ESERVFAIL (2 ms)
      ✓ resolveNs([]) throws ERR_INVALID_ARG_TYPE naming "name" (1 ms)
      ✓ missing callback throws ERR_INVALID_ARG_TYPE (1 ms)
    reverse / lookupService
      ✓ reverse resolves PTR via stub (11 ms)
      ✓ reverse throws EINVAL synchronously for non-IP (3 ms)
      ✓ lookupService validation mirrors Node (6 ms)
      ✓ lookupService accepts numeric string ports like Node
    Resolver
      ✓ constructor option validation mirrors Node (8 ms)
      ✓ setLocalAddress family rules mirror Node (5 ms)
      ✓ no lookup / setTimeout on Resolver (matches Node v24) (1 ms)
      ✓ getServers/setServers scoped per instance (2 ms)
      ✓ setLocalAddress (6 ms)
      ✓ setServers refuses while queries are pending (ERR_DNS_SET_SERVERS_FAILED) (2 ms)
      ✓ instance resolves via its own servers (3 ms)
      ✓ cancel() rejects in-flight queries with ECANCELLED (2 ms)
      ✓ timeout option → ETIMEOUT (259 ms)
    live DoH (network)
      ✓ resolve4 returns IPv4 addresses (127 ms)
      ✓ resolve6 returns IPv6 addresses (31 ms)
      ✓ lookup returns address + family (55 ms)
      ✓ resolveMx shape (13 ms)
      ✓ resolveTxt shape (12 ms)
      ✓ resolveSoa shape (26 ms)
      ✓ resolveNs shape (21 ms)
      ✓ resolveCaa shape (30 ms)
      ✓ resolveSrv shape (1387 ms)
      ✓ resolveNaptr shape (84 ms)
      ✓ reverse resolves PTR (10 ms)
      ✓ lookupService maps address + well-known port
      ✓ NXDOMAIN → ENOTFOUND (22 ms)
      ✓ promises.lookup resolves (16 ms)

PASS tests/stream_web.test.js
  stream/web shim
    module shape
      ✓ default export exposes ReadableStream (2 ms)
      ✓ default export exposes WritableStream (4 ms)
      ✓ default export exposes TransformStream
      ✓ default export exposes ReadableStreamDefaultReader (3 ms)
      ✓ default export exposes ReadableStreamBYOBReader
      ✓ default export exposes WritableStreamDefaultWriter (1 ms)
      ✓ default export exposes ReadableStreamDefaultController
      ✓ default export exposes ReadableByteStreamController (1 ms)
      ✓ default export exposes ReadableStreamBYOBRequest (1 ms)
      ✓ default export exposes WritableStreamDefaultController (1 ms)
      ✓ default export exposes TransformStreamDefaultController
      ✓ default export exposes ByteLengthQueuingStrategy (1 ms)
      ✓ default export exposes CountQueuingStrategy (2 ms)
      ✓ default export exposes TextEncoderStream
      ✓ default export exposes TextDecoderStream (1 ms)
      ✓ default export exposes CompressionStream (2 ms)
      ✓ default export exposes DecompressionStream (1 ms)
    ReadableStream
      ✓ can enqueue and read chunks (2 ms)
      ✓ cancel() resolves (1 ms)
      ✓ locked after getReader() (1 ms)
      ✓ pipeThrough a TransformStream (5 ms)
      ✓ pipeTo a WritableStream (1 ms)
      ✓ async iteration via tee() (1 ms)
    WritableStream
      ✓ write() and close() resolve (1 ms)
      ✓ locked after getWriter() (1 ms)
      ✓ abort() rejects pending writes (3 ms)
    TransformStream
      ✓ transforms chunks
      ✓ flush() is called on close (1 ms)
      ✓ identity transform (no transform fn) passes chunks through
    ByteLengthQueuingStrategy
      ✓ size() returns chunk.byteLength (1 ms)
      ✓ applies backpressure to ReadableStream (3 ms)
    CountQueuingStrategy
      ✓ size() always returns 1
    TextEncoderStream
      ✓ encodes string chunks to Uint8Array (5 ms)
      ✓ encoding property is utf-8 (1 ms)
      ✓ round-trips through TextDecoderStream (4 ms)
    TextDecoderStream
      ✓ decodes Uint8Array chunks to strings (1 ms)
      ✓ encoding property reflects constructor arg (3 ms)
    CompressionStream
      ✓ is a constructor
      ✓ throws a clear error when native API is unavailable (1 ms)
      ✓ compresses and decompresses gzip round-trip when native (9 ms)

PASS tests/zlib.test.js
  zlib (pako-backed ESM)
    constants and codes
      ✓ constants are frozen (7 ms)
      ✓ codes are frozen and bidirectional
      ✓ default export is frozen (1 ms)
    crc32
      ✓ crc32("hello") === 907060870
      ✓ crc32 of empty is 0
    deflate/inflate sync roundtrips
      ✓ deflateSync -> inflateSync (13 ms)
      ✓ deflateSync level 0 (stored) (1 ms)
      ✓ deflateRawSync -> inflateRawSync (1 ms)
      ✓ gzipSync -> gunzipSync (2 ms)
      ✓ unzipSync handles gzip and deflate (4 ms)
      ✓ roundtrip with larger data (48 ms)
    async convenience methods
      ✓ gzip -> gunzip callback (6 ms)
      ✓ deflate -> inflate callback (4 ms)
    stream classes
      ✓ Deflate -> Inflate stream roundtrip (2 ms)
      ✓ Gzip -> Gunzip stream roundtrip (8 ms)
      ✓ DeflateRaw -> InflateRaw stream roundtrip (2 ms)
    error handling
      ✓ inflateSync throws on invalid data (4 ms)
      ✓ gunzipSync throws on invalid gzip (1 ms)
    brotli and zstd (pass-through, not real codecs)
      ✓ brotliCompressSync passes through (1 ms)
      ✓ brotliDecompressSync passes through
    pako-backed codec behavior
      ✓ compression levels all round-trip; higher levels compress better (15 ms)
      ✓ deflate strategies all round-trip (43 ms)
      ✓ gunzipSync decodes concatenated gzip members (5 ms)
      ✓ unzipSync stops after the first zlib stream (2 ms)
      ✓ gunzipSync ignores zero padding but rejects junk (2 ms)
      ✓ dictionary round-trip and Node-shaped dictionary errors (5 ms)
      ✓ empty and truncated input report Z_BUF_ERROR (2 ms)
      ✓ inflateSync rejects gzip data; gunzipSync rejects zlib data (2 ms)
      ✓ stream flush emits incremental output (2 ms)
      ✓ params() mid-stream level change stays decodable (2 ms)
    browser lane
      ✓ no native delegation: works with process.getBuiltinModule disabled (8 ms)

PASS tests/inspector.test.js
  inspector shim
    module shape
      ✓ default export contains all expected members (2 ms)
      ✓ named exports match real node:inspector keys (1 ms)
    Session
      ✓ is an EventEmitter
      ✓ prototype has the real method names (1 ms)
      ✓ connect() does not throw (1 ms)
      ✓ connectToMainThread() does not throw
      ✓ disconnect() does not throw (1 ms)
      ✓ post() invokes callback asynchronously with (null, {}) (2 ms)
      ✓ post() shifts a function params slot into the callback slot (2 ms)
      ✓ post() without callback does not throw
      ✓ post() callback does not fire synchronously
      ✓ multiple post() calls each invoke their own callbacks (1 ms)
      ✓ can emit and receive custom events
    open()
      ✓ does not throw with no arguments
      ✓ does not throw with port, host, and wait arguments (3 ms)
    close()
      ✓ does not throw (1 ms)
    url()
      ✓ returns undefined (no inspector backend in the sandbox) (1 ms)
    waitForDebugger()
      ✓ does not throw
    console
      ✓ has exactly the real method names of node:inspector console (1 ms)
      ✓ all methods are functions (2 ms)
      ✓ delegates to the host console (2 ms)
      ✓ is a distinct object from the host console (1 ms)
    protocol agents
      ✓ Network has the real method names and is a noop (1 ms)
      ✓ DOMStorage has the real method names and is a noop
      ✓ NetworkResources has put() and is a noop (1 ms)
    inspector/promises
      ✓ Session is a subclass of the callback Session (1 ms)
      ✓ post() returns a promise resolving to {} (1 ms)
      ✓ post() works with params omitted (1 ms)
      ✓ inherits connect()/disconnect() as noops
      ✓ re-exports the base module members with identical identity (1 ms)
      ✓ Session is distinct from the callback Session
      ✓ has no default export (mirrors real node:inspector/promises CJS facade) (1 ms)
    browser fallback (no native delegation)
      ✓ module loads with the native bridge disabled (1 ms)
      ✓ session post() resolves (null, {}) without natives
      ✓ promises Session resolves {} without natives (1 ms)
      ✓ console delegation works without natives (1 ms)

PASS tests/readline_promises.test.js
  module shape
    ✓ exports exactly Interface, Readline and createInterface (3 ms)
    ✓ has no callback-style clearLine/moveCursor/cursorTo helpers (1 ms)
    ✓ named exports match the default export (1 ms)
    ✓ Readline is an output controller class, not an Interface (1 ms)
  readline/promises Interface
    ✓ createInterface returns an Interface instance (3 ms)
    ✓ cursor is undefined in non-terminal mode (matches Node) (1 ms)
    ✓ emits 'line' for each line and 'close' at EOF (3 ms)
    ✓ question() resolves with the answer (1 ms)
    ✓ question() rejects with AbortError when aborted (2 ms)
    ✓ question() rejects when the signal is already aborted (2 ms)
    ✓ async iterator yields lines (2 ms)
    ✓ pause()/resume()/write() after close throw ERR_USE_AFTER_CLOSE (6 ms)
    ✓ question() after close rejects with ERR_USE_AFTER_CLOSE (1 ms)
    ✓ close() is idempotent and emits close once (1 ms)
  readline/promises Readline
    ✓ constructs with a Writable stream (1 ms)
    ✓ throws ERR_INVALID_ARG_TYPE for non-writable output (2 ms)
    ✓ default autoCommit is false: writes queue until commit() (2 ms)
    ✓ autoCommit: true writes on next tick without commit() (1 ms)
    ✓ extra cursorTo arguments are ignored like Node (1 ms)
    ✓ clearLine with out-of-range direction throws ERR_OUT_OF_RANGE (2 ms)
    ✓ cursorTo with non-integer coordinates throws ERR_OUT_OF_RANGE (1 ms)
    ✓ rollback() discards queued operations (1 ms)
    ✓ chained calls return the Readline instance (1 ms)
    ✓ ANSI sequences match Node byte-for-byte (2 ms)
    ✓ non-boolean autoCommit throws ERR_INVALID_ARG_TYPE (1 ms)

(node:2395) [DEP0118] DeprecationWarning: The provided hostname "" is not a valid hostname, and is supported in the dns module solely for compatibility.
PASS tests/dns_promises.test.js
  dns/promises
    ✓ module namespace holds the promises API (no default export, like CJS require) (5 ms)
    ✓ argument validation throws synchronously (like node:dns/promises) (10 ms)
    ✓ resolve4 ignores a function options arg like node:dns/promises (8 ms)
    ✓ lookup: falsy hostnames resolve { address: null, family: 4 } (3 ms)
    ✓ lookup returns { address, family } (6 ms)
    ✓ lookup with all:true returns the array (4 ms)
    ✓ lookup rejects ENOTFOUND for NXDOMAIN (5 ms)
    ✓ lookup validation throws like Node (1 ms)
    ✓ resolve4 / resolveMx shapes (4 ms)
    ✓ resolve dispatches rrtype, defaults to A (4 ms)
    ✓ resolveAny rejects ENOTIMP like real Node (c-ares deprecated ANY) (1 ms)
    ✓ ENODATA for NOERROR-without-answers (2 ms)
    ✓ Resolver instance is scoped and cancellable (1 ms)
    ✓ setServers keeps callback and promises APIs in sync (1 ms)
    ✓ getDefaultResultOrder/setDefaultResultOrder (1 ms)
    ✓ reverse validation
    ✓ lookupService validation (1 ms)
    ✓ live: resolve4 + resolveTxt + reverse (55 ms)

PASS tests/cluster.test.js
  role flags (browser is always the primary)
    ✓ identifies as primary/master, never as a worker (3 ms)
    ✓ default export is the cluster EventEmitter singleton (1 ms)
    ✓ worker is undefined in the primary (1 ms)
    ✓ starts with empty settings and no workers (2 ms)
    ✓ scheduling constants and default policy (2 ms)
    ✓ schedulingPolicy is settable through the singleton (1 ms)
  Worker constructor (mirrors Node shape)
    ✓ bare construction matches Node: id 0, state none, no process (1 ms)
    ✓ accepts id/state/process options (2 ms)
    ✓ works without new (Node-compatible plain function) (1 ms)
    ✓ null/non-object options are tolerated (2 ms)
  fork() — stub worker, no real process
    ✓ returns a Worker with id and pid stub, registered in workers (2 ms)
    ✓ emits "fork" on the cluster asynchronously, not synchronously (12 ms)
    ✓ does not fabricate online/message/exit/disconnect events (10 ms)
    ✓ never creates a real OS process
  worker lifecycle stubs (honest noops)
    ✓ send() delivers nothing and returns false (11 ms)
    ✓ kill()/destroy()/disconnect() are noops; worker never dies
    ✓ disconnect() returns the worker like Node
  setupPrimary()
    ✓ fills Node-compatible defaults and merges cumulatively (2 ms)
    ✓ emits "setup" asynchronously with the settings object (11 ms)
    ✓ setupMaster is the same function (deprecated alias) (1 ms)
  cluster.disconnect()
    ✓ invokes the callback asynchronously, never synchronously (11 ms)
    ✓ works without a callback and ignores non-function callbacks (12 ms)
  emitter surface
    ✓ named emitter helpers are bound to the cluster singleton (1 ms)

PASS tests/trace_events.test.js
  trace_events stub
    export surface (matches node:trace_events)
      ✓ exports exactly createTracing and getEnabledCategories (3 ms)
      ✓ default export carries the same two functions
    createTracing() argument validation
      ✓ rejects non-object options: undefined (3 ms)
      ✓ rejects non-object options: null (1 ms)
      ✓ rejects non-object options: 1 (8 ms)
      ✓ rejects non-object options: "str" (2 ms)
      ✓ rejects non-object options: true (2 ms)
      ✓ rejects non-object options: ["node"] (1 ms)
      ✓ rejects non-object options: [Function anonymous] (2 ms)
      ✓ exact message for null options (1 ms)
      ✓ exact message for array options (2 ms)
      ✓ rejects non-array categories: undefined (1 ms)
      ✓ rejects non-array categories: "not-an-array" (1 ms)
      ✓ rejects non-array categories: 42 (1 ms)
      ✓ rejects non-array categories: true (1 ms)
      ✓ exact message for missing categories (1 ms)
      ✓ rejects non-string category entries without coercing (3 ms)
      ✓ rejects an empty categories array with TypeError (2 ms)
    Tracing object shape
      ✓ starts disabled with comma-joined categories
      ✓ exposes enable/disable on the prototype
      ✓ copies the categories array (later mutation is not reflected)
    enable()/disable() and getEnabledCategories()
      ✓ returns undefined when nothing is enabled (1 ms)
      ✓ enable() activates categories; disable() deactivates them (1 ms)
      ✓ enable()/disable() are idempotent (1 ms)
      ✓ reports the union of categories across tracings (1 ms)
      ✓ a category survives while any enabled Tracing still holds it (1 ms)
      ✓ enabled Tracing objects survive garbage collection (12 ms)
    memory-leak warning
      ✓ emits a warning past 10 enabled Tracing objects (2 ms)
      ✓ no warning at exactly 10 enabled Tracing objects
    util.inspect support
      ✓ renders like Node: Tracing { enabled: …, categories: '…' }

PASS tests/os.test.js
  os-web Browser Shim
    Hardware & Memory
      ✓ endianness() returns LE or BE using typed arrays (3 ms)
      ✓ totalmem() uses navigator.deviceMemory (1 ms)
      ✓ availableParallelism() and cpus() match hardwareConcurrency (2 ms)
    System Heuristics (Darwin Mock)
      ✓ identifies darwin/mac correctly (1 ms)
      ✓ uptime() converts performance.now to seconds (2 ms)
    Windows Heuristics
      ✓ identifies win32 from UserAgent (2 ms)
    Stubs & Constants
      ✓ networkInterfaces() returns loopback stub (1 ms)
      ✓ loadavg() always returns zeros (2 ms)
      ✓ constants are frozen and match Node values (1 ms)
      ✓ userInfo() returns plausible stub (2 ms)
  os module (Node.js compat)
    ✓ os.hostname() returns a string (1 ms)
    ✓ os.platform() returns a valid platform string
    ✓ os.arch() returns a valid architecture string (1 ms)
    ✓ os.type() returns a string
    ✓ os.release() returns a string
    ✓ os.version() returns a string
    ✓ os.machine() returns a string
    ✓ os.tmpdir() returns an absolute path (1 ms)
    ✓ os.homedir() returns an absolute path
    ✓ os.cpus() returns array with CPU info objects (3 ms)
    ✓ os.totalmem() and os.freemem() return positive numbers (1 ms)
    ✓ os.uptime() returns non-negative number (1 ms)
    ✓ os.loadavg() returns array of 3 numbers
    ✓ os.networkInterfaces() returns correct object shape (3 ms)
    ✓ os.userInfo() returns correct object shape (1 ms)
    ✓ os.endianness() returns BE or LE
    ✓ os.getPriority() and os.setPriority() do not throw (1 ms)
    ✓ os.EOL is valid
    ✓ os.constants contain expected values (1 ms)
    ✓ os.devNull is valid

PASS tests/fs_promises.test.js
  promises file I/O
    ✓ writeFile/readFile roundtrip (6 ms)
    ✓ appendFile (2 ms)
    ✓ readFile missing → ENOENT (2 ms)
    ✓ stat shape (3 ms)
    ✓ constants restored (1 ms)
    ✓ lchmod rejects with ERR_METHOD_NOT_IMPLEMENTED on linux (1 ms)
  promises directories
    ✓ mkdir/readdir/rmdir (2 ms)
    ✓ mkdtemp (2 ms)
    ✓ cp recursive (3 ms)
    ✓ glob as async iterable (3 ms)
    ✓ opendir for-await auto-closes (2 ms)
  FileHandle
    ✓ open/read/close (2 ms)
    ✓ no-arg read allocates buffer (1 ms)
    ✓ string write (1 ms)
    ✓ readv/writev (2 ms)
    ✓ stat shape (1 ms)
    ✓ readLines (5 ms)
    ✓ async iteration (1 ms)
    ✓ createReadStream from handle with autoClose (1 ms)
    ✓ readableWebStream (10 ms)
    ✓ FileHandle not publicly exposed (1 ms)
  promises watch
    ✓ watch yields events via async iteration (302 ms)
  promises misc
    ✓ lutimes/statfs (2 ms)
    ✓ truncate negative → 0 (1 ms)
    ✓ rename/unlink (2 ms)
    ✓ symlink/readlink/realpath (2 ms)

FAIL tests/crypto.test.js
  crypto native bridge (node)
    ✕ exports the full node:crypto surface (4 ms)
    ✓ native exports delegate to the real builtin by identity (5 ms)
    ✓ deprecated aliases are non-enumerable own props of require shape (1 ms)
    ✓ default export carries every named export (3 ms)
    ✓ subtle === webcrypto.subtle (1 ms)
  crypto browser fallback
    ✓ hashes match known empty-string vectors (4 ms)
    ✓ hmac-sha256 matches node (1 ms)
    ✓ one-shot hash matches node (1 ms)
    ✓ pbkdf2Sync matches node (RFC 2898) (129 ms)
    ✓ hkdfSync matches node (RFC 5869 vector 1) (2 ms)
    ✓ async pbkdf2/hkdf wrappers work (1 ms)
    ✓ random APIs have the right shape (5 ms)
    ✓ capability queries are honest (1 ms)
    ✓ OpenSSL-only APIs throw honest errors (12 ms)
    ✓ createHash rejects unknown digests like node (2 ms)

  ● crypto native bridge (node) › exports the full node:crypto surface

    expect(received).toBe(expected) // Object.is equality

    Expected: true
    Received: false

      30 |   test('exports the full node:crypto surface', () => {
      31 |     for (const name of EXPECTED_EXPORTS) {
    > 32 |       expect(typeof crypto[name] !== 'undefined').toBe(true);
         |                                                   ^
      33 |     }
      34 |   });
      35 |

      at Object.<anonymous> (tests/crypto.test.js:32:51)

PASS tests/stream_promises.test.js
  stream/promises — pipeline()
    ✓ resolves after all data flows through (9 ms)
    ✓ works with a Transform in the middle (2 ms)
    ✓ rejects when the source emits an error (2 ms)
    ✓ rejects when the sink emits an error (2 ms)
    ✓ destroys all streams on error (1 ms)
    ✓ supports AbortSignal cancellation (3 ms)
    ✓ rejects immediately if signal already aborted (1 ms)
    ✓ chains three streams correctly (1 ms)
  stream/promises — finished()
    ✓ resolves when a Readable ends normally (1 ms)
    ✓ resolves when a Writable finishes (1 ms)
    ✓ rejects when stream is destroyed with an error
    ✓ rejects on premature close (writable not finished)
    ✓ { readable: false } resolves on writable-side finish of a Duplex (1 ms)
    ✓ { error: false } does not reject on error event (1 ms)
    ✓ supports AbortSignal cancellation (1 ms)
    ✓ rejects immediately if signal already aborted
    ✓ stream already ended before finished() is called still resolves (1 ms)

PASS tests/assert.test.js
  assert-web (non-strict)
    exports shape
      ✓ default export exists (1 ms)
      ✓ named exports exist
      ✓ default contains same methods (1 ms)
    reference identity
      ✓ ok matches default reference (1 ms)
      ✓ equal matches default reference
      ✓ deepEqual matches default reference (1 ms)
      ✓ strictEqual matches default reference
      ✓ throws matches default reference (1 ms)
      ✓ match matches default reference
    equality (non-strict)
      ✓ equal allows type coercion (1 ms)
      ✓ notEqual allows type coercion (3 ms)
      ✓ deepEqual compares structurally but non-strict (1 ms)
      ✓ strictEqual still enforces strict equality
    core assertions
      ✓ ok passes for truthy
      ✓ ok throws for falsy (2 ms)
      ✓ fail always throws
      ✓ ifError throws on truthy error (2 ms)
      ✓ ifError does not throw on null/undefined
    sync error assertions
      ✓ throws detects error (1 ms)
      ✓ throws fails when no error (1 ms)
      ✓ doesNotThrow passes when no error
      ✓ doesNotThrow fails when error thrown (1 ms)
    async assertions
      ✓ rejects detects rejection (1 ms)
      ✓ rejects fails on resolve
      ✓ doesNotReject passes on resolve (1 ms)
      ✓ doesNotReject fails on rejection (1 ms)
    match / doesNotMatch
      ✓ match passes when regex matches
      ✓ match throws when no match (2 ms)
      ✓ doesNotMatch passes when no match (1 ms)
      ✓ doesNotMatch throws when matches (1 ms)
    AssertionError
      ✓ is exposed on default export
      ✓ throws AssertionError instances (1 ms)

PASS tests/assert_strict.test.js
  assert-strict-web
    exports shape
      ✓ default export exists (2 ms)
      ✓ named exports exist (1 ms)
      ✓ default contains same methods
      ✓ self-referential strict (1 ms)
    reference identity
      ✓ ok matches default reference
      ✓ equal matches default reference
      ✓ deepEqual matches default reference
      ✓ strictEqual matches default reference
      ✓ throws matches default reference
      ✓ match matches default reference
    equality (strict)
      ✓ equal behaves like strictEqual (4 ms)
      ✓ deepEqual behaves like deepStrictEqual (1 ms)
      ✓ notEqual behaves like notStrictEqual (1 ms)
    core assertions
      ✓ ok passes for truthy (1 ms)
      ✓ ok throws for falsy (1 ms)
      ✓ fail always throws (1 ms)
      ✓ ifError throws on truthy (1 ms)
      ✓ ifError does not throw on null/undefined
    sync error assertions
      ✓ throws detects error (1 ms)
      ✓ throws fails when no error (1 ms)
      ✓ doesNotThrow passes when no error
      ✓ doesNotThrow fails when error thrown (1 ms)
    async assertions
      ✓ rejects detects rejection (1 ms)
      ✓ rejects fails on resolve (1 ms)
      ✓ doesNotReject passes on resolve
      ✓ doesNotReject fails on rejection (1 ms)
    match / doesNotMatch
      ✓ match passes when regex matches (1 ms)
      ✓ match throws when no match (1 ms)
      ✓ doesNotMatch passes when no match (1 ms)
      ✓ doesNotMatch throws when matches (1 ms)
    AssertionError
      ✓ is exposed on default export
      ✓ throws AssertionError instances (1 ms)

PASS tests/timers.test.js
  timers-web
    setTimeout / clearTimeout
      ✓ setTimeout returns Timeout with close (23 ms)
      ✓ timeout fires after delay with args (11 ms)
      ✓ Timeout ref/unref are no-ops (1 ms)
      ✓ Timeout Symbol.toPrimitive returns id (2 ms)
    setInterval / clearInterval
      ✓ interval fires repeatedly until cleared (51 ms)
    setImmediate / clearImmediate
      ✓ setImmediate fires in next tick (1 ms)
      ✓ Immediate close cancels (23 ms)
      ✓ Immediate ref/unref are no-ops
    clearTimeout / clearInterval
      ✓ clears numeric timer id (21 ms)
      ✓ clears Timeout/Interval object (21 ms)
    clearImmediate
      ✓ clears numeric immediate id (21 ms)
    legacy idle-timeout helpers
      ✓ enroll sets _idleTimeout (1 ms)
      ✓ unenroll cancels timer and sets _idleTimeout to -1 (21 ms)
      ✓ active schedules _onTimeout after _idleTimeout (27 ms)
      ✓ _unrefActive alias works (16 ms)
    default export
      ✓ has all timer functions (2 ms)

PASS tests/path.test.js
  win32 path implementation
    resolve()
      ✓ resolve([ 'C:\\foo', 'bar', [length]: 2 ]) (3 ms)
      ✓ resolve([ 'C:\\foo', '..\\bar', [length]: 2 ]) (1 ms)
      ✓ resolve([ 'C:\\foo', 'C:\\bar', [length]: 2 ])
      ✓ resolve([ '', 'foo', [length]: 2 ]) (1 ms)
    normalize()
      ✓ normalize(C:\foo\..\bar) (1 ms)
      ✓ normalize(C:/foo//bar\baz) (1 ms)
      ✓ normalize(foo\..\bar) (1 ms)
      ✓ normalize(.) (1 ms)
    isAbsolute()
      ✓ isAbsolute(C:\foo) (1 ms)
      ✓ isAbsolute(\foo)
      ✓ isAbsolute(foo\bar)
      ✓ isAbsolute(C:foo)
    join()
      ✓ join([ 'C:\\foo', 'bar', [length]: 2 ]) (1 ms)
      ✓ join([ 'C:\\foo', '..', 'bar', [length]: 3 ]) (1 ms)
      ✓ join([ 'foo', 'bar', 'baz', [length]: 3 ]) (1 ms)
      ✓ join([ [length]: 0 ]) (1 ms)
    relative()
      ✓ relative(C:\foo\bar, C:\foo\baz) (1 ms)
      ✓ relative(C:\foo, C:\foo\bar) (1 ms)
      ✓ relative(C:\foo\bar, C:\foo\bar)
      ✓ relative(C:\Users\Alice, C:\users\alice\docs)
    dirname()
      ✓ dirname(C:\foo\bar\baz.txt)
      ✓ dirname(C:\foo\bar\)
      ✓ dirname(C:\) (1 ms)
      ✓ dirname(foo) (1 ms)
    basename()
      ✓ basename(C:\foo\bar.txt) (1 ms)
      ✓ basename(C:\foo\bar.txt) (1 ms)
      ✓ basename(C:\foo\bar) (1 ms)
    extname()
      ✓ extname(file.txt) (1 ms)
      ✓ extname(archive.tar.gz) (1 ms)
      ✓ extname(noext)
      ✓ extname(.gitignore) (1 ms)
    parse() and format()
      ✓ parse basic path (2 ms)
      ✓ format reconstructs path (1 ms)
    edge cases
      ✓ throws on non-string (3 ms)
      ✓ empty string normalize (1 ms)
      ✓ UNC path parse (1 ms)

PASS tests/https.test.js
  https surface
    ✓ exports exactly Server/createServer/request/get/Agent/globalAgent (3 ms)
  https.Agent
    ✓ defaults match Node (443, https:, maxCachedSessions 100) (1 ms)
    ✓ globalAgent is an https Agent (1 ms)
    ✓ explicit options win over https defaults (1 ms)
  https.Server
    ✓ extends http.Server and shares the virtual registry (3 ms)
    ✓ setSecureContext is accepted and ignored
  https client (fetch bridge)
    ✓ request forces the https: protocol (3 ms)
    ✓ options without protocol default to https: (2 ms)
    ✓ get() ends the request (51 ms)
    ✓ http: URL through https.request throws ERR_INVALID_PROTOCOL (1 ms)
    ✓ TLS options are accepted and ignored (2 ms)

  console.warn
    A function to advance timers was called but the timers APIs are not replaced with fake timers. Call `jest.useFakeTimers()` in this test file or enable fake timers for all tests by setting 'fakeTimers': {'enableGlobally': true} in Jest configuration file.
    Stack Trace:
    
          23 |    it('uses default delay when none is provided', async () => {
          24 |      const promise = tpSetTimeout();
        > 25 |      jest.advanceTimersByTime(0); // force the timer to run
             |           ^
          26 |      await expect(promise).resolves.toBeUndefined(); // default value
          27 |    });
          28 |
    
          Error: 
          at FakeTimers._checkFakeTimers (node_modules/@jest/fake-timers/build/index.js:654:7)
          at Object.<anonymous> (tests/timers_promises.test.js:25:11)

      23 |    it('uses default delay when none is provided', async () => {
      24 |      const promise = tpSetTimeout();
    > 25 |      jest.advanceTimersByTime(0); // force the timer to run
         |           ^
      26 |      await expect(promise).resolves.toBeUndefined(); // default value
      27 |    });
      28 |

      at FakeTimers._checkFakeTimers (node_modules/@jest/fake-timers/build/index.js:652:28)
      at Object.<anonymous> (tests/timers_promises.test.js:25:11)

PASS tests/runtime_error_stacks.test.js
  __parseStackLocation (URL-safe V8 frame parser)
    ✓ parses "at fn (https://host/app.js:10:15)" (3 ms)
    ✓ parses async frames (1 ms)
    ✓ parses bare-location frames
    ✓ does not mistake the URL scheme for line/column separators (1 ms)
    ✓ survives URLs with ports
    ✓ parses http://localhost frames (1 ms)
    ✓ parses file:// frames
    ✓ returns null for native/anonymous frames (1 ms)
    ✓ returns null for empty/garbage input
    ✓ inlined template copy stays in sync (single source of truth) (1 ms)

PASS tests/buffer.test.js
  Buffer Shim Compliance
    Export Integrity
      ✓ default export should match named exports (2 ms)
      ✓ should export core Node.js Buffer properties
    isAscii()
      ✓ should throw ERR_INVALID_ARG_TYPE for string input (matches real Node) (3 ms)
      ✓ should throw ERR_INVALID_ARG_TYPE for non-ASCII string input
      ✓ should handle Buffer input (1 ms)
    isUtf8()
      ✓ should throw ERR_INVALID_ARG_TYPE for string input (matches real Node) (1 ms)
      ✓ should return false for invalid UTF-8 sequences
    transcode()
      ✓ should transcode between encodings (1 ms)
      ✓ should throw ERR_INVALID_ARG_TYPE for string input (matches real Node) (1 ms)
    Safety Stubs
      ✓ resolveObjectURL matches real Node when native buffer is available
      ✓ resolveObjectURL is undefined (not silently broken) in the browser fallback lane (4 ms)
    Web API Mapping
      ✓ atob/btoa should be function or undefined depending on environment
      ✓ Blob and File should be exported if available (1 ms)

PASS tests/assert_deep.test.js
  assert-web deep equality behavior
    ✓ Uint8Array vs Buffer (6 ms)
    ✓ extra properties break strict equality (2 ms)
    ✓ loose vs strict equality (1 ms)
    ✓ NaN handling
    ✓ Dates (1 ms)
    ✓ RegExp (1 ms)
    ✓ Arrays (2 ms)
    ✓ Objects (1 ms)
    ✓ Set equality (5 ms)
    ✓ Map equality (2 ms)
    ✓ Errors (1 ms)
    ✓ boxed primitives (2 ms)
    ✓ symbols
    ✓ throws behavior
    ✓ strictEqual basics
    ✓ notStrictEqual basics (1 ms)

PASS tests/timers_promises.test.js
  timers/promises
    setTimeout
      ✓ resolves after a delay with the given value (52 ms)
      ✓ uses default delay when none is provided (33 ms)
      ✓ rejects immediately if signal is already aborted (2 ms)
      ✓ rejects if aborted during the timeout (22 ms)
      ✓ rejects with ERR_INVALID_ARG_TYPE for invalid delay (1 ms)
      ✓ rejects with ERR_INVALID_ARG_TYPE for invalid options (1 ms)
    setImmediate
      ✓ resolves with the given value (1 ms)
      ✓ rejects immediately if signal is already aborted (1 ms)
      ✓ rejects with ERR_INVALID_ARG_TYPE for invalid options (1 ms)
    setInterval
      ✓ yields multiple values asynchronously (62 ms)
      ✓ throws AbortError if signal is aborted during iteration (62 ms)
      ✓ throws immediately if signal is already aborted (1 ms)
      ✓ throws ERR_INVALID_ARG_TYPE for invalid delay (1 ms)
    scheduler
      ✓ scheduler.wait resolves after given delay (31 ms)
      ✓ scheduler.yield resolves immediately (next tick) (1 ms)

PASS tests/convertESMtoCJS.test.js
  convertEsmToCjs
    ✓ converts default export of a literal (9 ms)
    ✓ converts default export of a named function (3 ms)
    ✓ converts named export of variable (2 ms)
    ✓ converts named export of function (1 ms)
    ✓ converts import statements (default, named, namespace, bare) (2 ms)
    ✓ converts export all and re-export (2 ms)
  convertCjsToEsm
    ✓ converts module.exports = literal to default export (2 ms)
    ✓ converts module.exports = named function to default export (1 ms)
    ✓ converts exports properties to named exports if no module.exports (1 ms)
    ✓ removes previous module.exports if overwritten (2 ms)
    ✓ removes exports.* if module.exports is used (1 ms)

PASS tests/bundler.test.js
  moduleLoader public API
    ✓ bundles a simple module without dependencies (12 ms)
    ✓ throws if a fetch fails (3 ms)
    ✓ supports multiple bundles independently (3 ms)

FAIL tests/constants.test.js
  constants — port of node:constants (values captured from Node v24.20.0)
    ✕ exports the same key set as the real builtin (236 keys + ESM default) (15 ms)
    ✕ differential: every key matches the real node:constants value (21 ms)
    ✕ default export is the full namespace object and is frozen (12 ms)
    ✓ spot-checks of well-known values (2 ms)
    ✕ cipher list strings are preserved verbatim (1 ms)

  ● constants — port of node:constants (values captured from Node v24.20.0) › exports the same key set as the real builtin (236 keys + ESM default)

    expect(received).toEqual(expected) // deep equality

    - Expected  - 2
    + Received  + 2

    @@ -94,12 +94,10 @@
        "ETIME",
        "ETIMEDOUT",
        "ETXTBSY",
        "EWOULDBLOCK",
        "EXDEV",
    -   "EXTENSIONLESS_FORMAT_JAVASCRIPT",
    -   "EXTENSIONLESS_FORMAT_WASM",
        "F_OK",
        "OPENSSL_VERSION_NUMBER",
        "O_APPEND",
        "O_CREAT",
        "O_DIRECT",
    @@ -129,10 +127,11 @@
        "RSA_PKCS1_PADDING",
        "RSA_PKCS1_PSS_PADDING",
        "RSA_PSS_SALTLEN_AUTO",
        "RSA_PSS_SALTLEN_DIGEST",
        "RSA_PSS_SALTLEN_MAX_SIGN",
    +   "RSA_SSLV23_PADDING",
        "RSA_X931_PADDING",
        "RTLD_DEEPBIND",
        "RTLD_GLOBAL",
        "RTLD_LAZY",
        "RTLD_LOCAL",
    @@ -232,7 +231,8 @@
        "UV_FS_O_FILEMAP",
        "UV_FS_SYMLINK_DIR",
        "UV_FS_SYMLINK_JUNCTION",
        "W_OK",
        "X_OK",
    +   "defaultCipherList",
        "defaultCoreCipherList",
      ]

      12 |     const realKeys = Object.keys(real).sort();
      13 |     const shimKeys = Object.keys(shimNs).filter(k => k !== 'default').sort();
    > 14 |     expect(shimKeys).toEqual(realKeys);
         |                      ^
      15 |     expect(Object.keys(shimNs)).toHaveLength(237); // 236 named + default
      16 |   });
      17 |

      at Object.<anonymous> (tests/constants.test.js:14:22)

  ● constants — port of node:constants (values captured from Node v24.20.0) › differential: every key matches the real node:constants value

    expect(received).toStrictEqual(expected) // deep equality

    Expected: 0
    Received: undefined

      18 |   test('differential: every key matches the real node:constants value', () => {
      19 |     for (const k of Object.keys(real)) {
    > 20 |       expect(shimNs[k]).toStrictEqual(real[k]);
         |                         ^
      21 |     }
      22 |   });
      23 |

      at Object.<anonymous> (tests/constants.test.js:20:25)

  ● constants — port of node:constants (values captured from Node v24.20.0) › default export is the full namespace object and is frozen

    expect(received).toStrictEqual(expected) // deep equality

    Expected: 0
    Received: undefined

      26 |     expect(typeof shimDefault).toBe('object');
      27 |     for (const k of Object.keys(real)) {
    > 28 |       expect(shimDefault[k]).toStrictEqual(real[k]);
         |                              ^
      29 |     }
      30 |     // The real module freezes its exports object; we mirror that.
      31 |     expect(Object.isFrozen(real)).toBe(true);

      at Object.<anonymous> (tests/constants.test.js:28:30)

  ● constants — port of node:constants (values captured from Node v24.20.0) › cipher list strings are preserved verbatim

    expect(received).toBe(expected) // Object.is equality

    Expected: undefined
    Received: "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA"

      54 |     expect(typeof shimNs.defaultCoreCipherList).toBe('string');
      55 |     expect(shimNs.defaultCipherList).toContain('TLS_AES_256_GCM_SHA384');
    > 56 |     expect(shimNs.defaultCipherList).toBe(real.defaultCipherList);
         |                                      ^
      57 |   });
      58 | });
      59 |

      at Object.<anonymous> (tests/constants.test.js:56:38)

PASS tests/zlib-native-compat.test.js
  zlib native differential (pako vs node:zlib)
    ✓ native accepts our deflate output (levels 0/1/6/9) (30 ms)
    ✓ we accept native deflate output (10 ms)
    ✓ native accepts our gzip output; we accept native gzip output (10 ms)
    ✓ raw cross-compatibility both ways (9 ms)
    ✓ deflate output is byte-identical to native zlib (17 ms)
    ✓ unzip accepts native gzip and zlib streams (2 ms)
    ✓ dictionary output is accepted by native with the same dictionary (4 ms)

(node:2395) [DEP0025] DeprecationWarning: sys is deprecated. Use util instead.
PASS tests/sys.test.js
  sys shim (util)
    ✓ exports util module (2 ms)
    ✓ does not fail if process is undefined (1 ms)

PASS tests/diagnostic_channel.test.js
  diagnostics_channel shim
    ✓ channel() should return a Channel object with a name (3 ms)
    ✓ should trigger subscriber when message is published (3 ms)
    ✓ hasSubscribers() should correctly reflect state (1 ms)
    ✓ Channel.publish() should work via the instance (1 ms)
    ✓ should handle multiple subscribers for the same channel (2 ms)

FAIL tests/v8.test.js (6.209 s)
  v8 shim
    module shape
      ✓ default export contains all expected members (6 ms)
    getHeapStatistics()
      ✓ returns an object with the exact Node v24 numeric key set (4 ms)
    getHeapSpaceStatistics()
      ✓ returns a non-empty array of space objects (1 ms)
      ✓ each space has correct shape (3 ms)
      ✓ includes expected space names (1 ms)
    getHeapCodeStatistics()
      ✓ returns object with expected numeric keys (15 ms)
    getCppHeapStatistics()
      ✕ returns object with the real v24 key set
      ✕ honours the 'brief' detail level
      ✕ rejects an invalid detail level like Node (8 ms)
    getHeapSnapshot()
      ✓ returns a readable stream of the snapshot (real Node behaviour) (2382 ms)
    writeHeapSnapshot()
      ✓ returns provided filename when given (1915 ms)
      ✓ returns a generated filename when called without arguments (1763 ms)
    serialize() / deserialize()
      ✓ round-trips a plain object (1 ms)
      ✓ round-trips primitives (2 ms)
      ✓ round-trips nested objects (1 ms)
    Serializer
      ✓ can be instantiated
      ✓ stub methods do not throw (1 ms)
      ✓ releaseBuffer() returns a Buffer (1 ms)
    Deserializer
      ✓ can be instantiated with a buffer
      ✓ readHeader() throws on invalid data (matches Node) (1 ms)
      ✓ reads back real Serializer output
      ✓ getWireFormatVersion() returns a number (1 ms)
    DefaultSerializer / DefaultDeserializer
      ✓ DefaultSerializer extends Serializer (1 ms)
      ✓ DefaultDeserializer extends Deserializer (1 ms)
    GCProfiler
      ✓ start() does not throw (1 ms)
      ✓ stop() returns expected shape (2 ms)
    setFlagsFromString()
      ✓ does not throw (1 ms)
    cachedDataVersionTag()
      ✓ returns a number (1 ms)
    takeCoverage() / stopCoverage()
      ✓ do not throw (1 ms)
    startupSnapshot
      ✓ has expected methods (1 ms)
      ✓ isBuildingSnapshot() is falsy (real Node returns 0) (1 ms)
      ✓ callbacks throw when not building a snapshot (matches Node) (5 ms)
    promiseHooks
      ✓ has expected hook methods (3 ms)
      ✓ individual hooks return a stop function (matches Node) (1 ms)
      ✓ a registered init hook fires, then stops firing after stop() (2 ms)
      ✓ createHook() returns a stop function (matches Node)

  ● v8 shim › getCppHeapStatistics() › returns object with the real v24 key set

    TypeError: getCppHeapStatistics is not a function

      108 |   describe('getCppHeapStatistics()', () => {
      109 |     test('returns object with the real v24 key set', () => {
    > 110 |       const stats = getCppHeapStatistics();
          |                     ^
      111 |       expect(typeof stats.committed_size_bytes).toBe('number');
      112 |       expect(typeof stats.resident_size_bytes).toBe('number');
      113 |       expect(typeof stats.used_size_bytes).toBe('number');

      at Object.<anonymous> (tests/v8.test.js:110:21)

  ● v8 shim › getCppHeapStatistics() › honours the 'brief' detail level

    TypeError: getCppHeapStatistics is not a function

      118 |
      119 |     test("honours the 'brief' detail level", () => {
    > 120 |       expect(getCppHeapStatistics('brief').detail_level).toBe('brief');
          |              ^
      121 |     });
      122 |
      123 |     test('rejects an invalid detail level like Node', () => {

      at Object.<anonymous> (tests/v8.test.js:120:14)

  ● v8 shim › getCppHeapStatistics() › rejects an invalid detail level like Node

    expect(received).toThrow(expected)

    Expected asymmetric matcher: ObjectContaining {"code": "ERR_INVALID_ARG_VALUE"}

    Received name:    "TypeError"
    Received message: "getCppHeapStatistics is not a function"

          122 |
          123 |     test('rejects an invalid detail level like Node', () => {
        > 124 |       expect(() => getCppHeapStatistics('bogus')).toThrow(
              |                    ^
          125 |         expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }),
          126 |       );
          127 |     });

      at tests/v8.test.js:124:20
      at Object.<anonymous> (node_modules/expect/build/index.js:1824:9)
      at Object.throwingMatcher [as toThrow] (node_modules/expect/build/index.js:2235:93)
      at Object.<anonymous> (tests/v8.test.js:124:51)
      at Object.<anonymous> (tests/v8.test.js:124:51)

A worker process has failed to exit gracefully and has been force exited. This is likely caused by tests leaking due to improper teardown. Try running with --detectOpenHandles to find leaks. Active timers can also cause this, ensure that .unref() was called on them.
Summary of all failing tests
FAIL tests/module.test.js
  ● export surface › ESM named exports match node:module exactly

    expect(received).toEqual(expected) // deep equality

    - Expected  - 0
    + Received  + 9

    @@ -11,13 +11,22 @@
        "_pathCache",
        "_preloadModules",
        "_resolveFilename",
        "_resolveLookupPaths",
        "builtinModules",
    +   "constants",
        "createRequire",
    +   "enableCompileCache",
    +   "findPackageJSON",
        "findSourceMap",
    +   "flushCompileCache",
    +   "getCompileCacheDir",
    +   "getSourceMapsSupport",
        "globalPaths",
        "isBuiltin",
        "register",
    +   "registerHooks",
        "runMain",
    +   "setSourceMapsSupport",
    +   "stripTypeScriptTypes",
        "syncBuiltinESMExports",
      ]

      40 |     const realKeys = Object.keys(real).filter((k) => k !== 'default').sort();
      41 |     const shimKeys = Object.keys(shim).filter((k) => k !== 'default').sort();
    > 42 |     expect(shimKeys).toEqual(realKeys);
         |                      ^
      43 |   });
      44 |
      45 |   test('default export is the Module class', () => {

      at Object.<anonymous> (tests/module.test.js:42:22)

  ● builtinModules / isBuiltin › builtinModules is frozen and identical to real

    expect(received).toEqual(expected) // deep equality

    - Expected  - 0
    + Received  + 4

    @@ -65,6 +65,10 @@
        "v8",
        "vm",
        "wasi",
        "worker_threads",
        "zlib",
    +   "node:sea",
    +   "node:sqlite",
    +   "node:test",
    +   "node:test/reporters",
      ]

      73 |   test('builtinModules is frozen and identical to real', () => {
      74 |     expect(Object.isFrozen(shim.builtinModules)).toBe(true);
    > 75 |     expect([...shim.builtinModules]).toEqual([...real.builtinModules]);
         |                                      ^
      76 |     expect(shim.builtinModules.length).toBe(72);
      77 |     expect(shim.builtinModules).toContain('node:test/reporters');
      78 |     expect(shim.builtinModules).toContain('node:sea');

      at Object.<anonymous> (tests/module.test.js:75:38)

  ● builtinModules / isBuiltin › isBuiltin("node:sqlite") === true

    expect(received).toBe(expected) // Object.is equality

    Expected: false
    Received: true

      104 |   ])('isBuiltin(%p) === %p', (name, expected) => {
      105 |     expect(shim.isBuiltin(name)).toBe(expected);
    > 106 |     expect(shim.isBuiltin(name)).toBe(real.isBuiltin(name));
          |                                  ^
      107 |   });
      108 |
      109 |   test('isBuiltin() with no args is false (does not throw)', () => {

      at tests/module.test.js:106:34

  ● error forms › received-value rendering matches real Node

    expect(received).toBe(expected) // Object.is equality

    Expected: "TypeError: real.setSourceMapsSupport is not a function"
    Received: "TypeError [ERR_INVALID_ARG_TYPE]: The \"options.nodeModules\" property must be of type boolean. Received an instance of Object"

      398 |       try { shim.setSourceMapsSupport(true, { nodeModules: v }); } catch (e) { mine = String(e); }
      399 |       try { real.setSourceMapsSupport(true, { nodeModules: v }); } catch (e) { theirs = String(e); }
    > 400 |       expect(mine).toBe(theirs);
          |                    ^
      401 |     }
      402 |   });
      403 | });

      at Object.<anonymous> (tests/module.test.js:400:20)

  ● compile cache › constants match real

    expect(received).toEqual(expected) // deep equality

    Expected: undefined
    Received: {"compileCacheStatus": {"ALREADY_ENABLED": 2, "DISABLED": 3, "ENABLED": 1, "FAILED": 0}}

      408 | describe('compile cache', () => {
      409 |   test('constants match real', () => {
    > 410 |     expect(shim.constants).toEqual(real.constants);
          |                            ^
      411 |     expect(shim.constants.compileCacheStatus).toEqual({
      412 |       FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3,
      413 |     });

      at Object.<anonymous> (tests/module.test.js:410:28)

  ● compile cache › enableCompileCache reports FAILED (cannot work in browser)

    TypeError: Cannot read properties of undefined (reading 'compileCacheStatus')

      417 |     expect(shim.enableCompileCache()).toEqual({ status: 0, directory: undefined });
      418 |     expect(shim.enableCompileCache('/tmp/x').status)
    > 419 |       .toBe(real.constants.compileCacheStatus.FAILED);
          |                            ^
      420 |   });
      421 |
      422 |   test('getCompileCacheDir / flushCompileCache', () => {

      at Object.<anonymous> (tests/module.test.js:419:28)

  ● source maps › getSourceMapsSupport default matches real

    TypeError: real.getSourceMapsSupport is not a function

      432 |   test('getSourceMapsSupport default matches real', () => {
      433 |     expect(shim.getSourceMapsSupport()).toEqual(
    > 434 |       JSON.parse(JSON.stringify(real.getSourceMapsSupport())),
          |                                      ^
      435 |     );
      436 |   });
      437 |

      at Object.<anonymous> (tests/module.test.js:434:38)

  ● source maps › setSourceMapsSupport validates like real

    expect(received).toBe(expected) // Object.is equality

    Expected: "TypeError: real.setSourceMapsSupport is not a function"
    Received: "TypeError [ERR_INVALID_ARG_TYPE]: The \"enabled\" argument must be of type boolean. Received null"

      441 |       try { shim.setSourceMapsSupport(...args); } catch (e) { mine = String(e); }
      442 |       try { real.setSourceMapsSupport(...args); } catch (e) { theirs = String(e); }
    > 443 |       expect(mine).toBe(theirs);
          |                    ^
      444 |     }
      445 |     shim.setSourceMapsSupport(true, { nodeModules: true, generatedCode: false });
      446 |     expect(shim.getSourceMapsSupport().enabled).toBe(true);

      at Object.<anonymous> (tests/module.test.js:443:20)

  ● stripTypeScriptTypes › validates like real Node

    expect(received).toBe(expected) // Object.is equality

    Expected: "TypeError: real.stripTypeScriptTypes is not a function"
    Received: "TypeError [ERR_INVALID_ARG_TYPE]: The \"code\" argument must be of type string. Received type number (42)"

      586 |       try { shim.stripTypeScriptTypes(...args); } catch (e) { mine = String(e); }
      587 |       try { real.stripTypeScriptTypes(...args); } catch (e) { theirs = String(e); }
    > 588 |       expect(mine).toBe(theirs);
          |                    ^
      589 |     }
      590 |   });
      591 |

      at Object.<anonymous> (tests/module.test.js:588:20)

  ● stripTypeScriptTypes › honors sourceUrl suffix like real

    TypeError: real.stripTypeScriptTypes is not a function

      597 |   test('honors sourceUrl suffix like real', () => {
      598 |     expect(shim.stripTypeScriptTypes('x', { mode: 'strip', sourceUrl: 'foo.ts' }))
    > 599 |       .toBe(real.stripTypeScriptTypes('x', { mode: 'strip', sourceUrl: 'foo.ts' }));
          |                  ^
      600 |     expect(shim.stripTypeScriptTypes('x', { sourceUrl: '' })).toBe('x');
      601 |   });
      602 | });

      at Object.<anonymous> (tests/module.test.js:599:18)

FAIL tests/async_hooks.test.js
  ● export surface (both lanes) › asyncWrapProviders is the frozen v24.20.0 enum

    expect(received).toBe(expected) // Object.is equality

    Expected: 27
    Received: 26

      62 |     expect(Object.getPrototypeOf(ah.asyncWrapProviders)).toBe(null);
      63 |     expect(ah.asyncWrapProviders.NONE).toBe(0);
    > 64 |     expect(ah.asyncWrapProviders.PROMISE).toBe(27);
         |                                           ^
      65 |     expect(ah.asyncWrapProviders.TCPWRAP).toBe(40);
      66 |     expect(Object.keys(ah.asyncWrapProviders)).toHaveLength(68);
      67 |   });

      at Object.<anonymous> (tests/async_hooks.test.js:64:43)

FAIL tests/tls.test.js
  ● tls browser port — export surface › named exports match real node:tls exactly

    expect(received).toEqual(expected) // deep equality

    - Expected  - 1
    + Received  + 3

    @@ -10,10 +10,12 @@
        "TLSSocket",
        "checkServerIdentity",
        "connect",
        "convertALPNProtocols",
        "createSecureContext",
    -   "createSecurePair",
        "createServer",
    +   "getCACertificates",
    +   "getCertificateCompressionAlgorithms",
        "getCiphers",
        "rootCertificates",
    +   "setDefaultCACertificates",
      ]

      13 |     const shim = Object.keys(tlsNs).filter((k) => k !== 'default').sort();
      14 |     const real = Object.keys(realTls).sort();
    > 15 |     expect(shim).toEqual(real);
         |                  ^
      16 |   });
      17 |
      18 |   test('default export carries the same surface', () => {

      at Object.<anonymous> (tests/tls.test.js:15:18)

FAIL tests/tty.test.js
  ● getColorDepth() › getColorDepth({"TERM": "xterm-kitty"}) === 24

    expect(received).toBe(expected) // Object.is equality

    Expected: 4
    Received: 24

      361 |     // and it matches real node:tty exactly
      362 |     const r = new realTty.WriteStream(1);
    > 363 |     expect(s.getColorDepth({ ...env })).toBe(r.getColorDepth({ ...env }));
          |                                         ^
      364 |     s.destroy();
      365 |     r.destroy();
      366 |   });

      at tests/tty.test.js:363:41

  ● getColorDepth() › getColorDepth({"TERM": "XTERM-KITTY"}) === 24

    expect(received).toBe(expected) // Object.is equality

    Expected: 4
    Received: 24

      361 |     // and it matches real node:tty exactly
      362 |     const r = new realTty.WriteStream(1);
    > 363 |     expect(s.getColorDepth({ ...env })).toBe(r.getColorDepth({ ...env }));
          |                                         ^
      364 |     s.destroy();
      365 |     r.destroy();
      366 |   });

      at tests/tty.test.js:363:41

  ● getColorDepth() › getColorDepth({"TERM": "xterm-truecolor"}) === 24

    expect(received).toBe(expected) // Object.is equality

    Expected: 4
    Received: 24

      361 |     // and it matches real node:tty exactly
      362 |     const r = new realTty.WriteStream(1);
    > 363 |     expect(s.getColorDepth({ ...env })).toBe(r.getColorDepth({ ...env }));
          |                                         ^
      364 |     s.destroy();
      365 |     r.destroy();
      366 |   });

      at tests/tty.test.js:363:41

  ● getColorDepth() › getColorDepth({"TMUX": "1"}) === 24

    expect(received).toBe(expected) // Object.is equality

    Expected: 8
    Received: 24

      361 |     // and it matches real node:tty exactly
      362 |     const r = new realTty.WriteStream(1);
    > 363 |     expect(s.getColorDepth({ ...env })).toBe(r.getColorDepth({ ...env }));
          |                                         ^
      364 |     s.destroy();
      365 |     r.destroy();
      366 |   });

      at tests/tty.test.js:363:41

  ● getColorDepth() › getColorDepth({"CI": "true", "GITHUB_ACTIONS": "true"}) === 24

    expect(received).toBe(expected) // Object.is equality

    Expected: 8
    Received: 24

      361 |     // and it matches real node:tty exactly
      362 |     const r = new realTty.WriteStream(1);
    > 363 |     expect(s.getColorDepth({ ...env })).toBe(r.getColorDepth({ ...env }));
          |                                         ^
      364 |     s.destroy();
      365 |     r.destroy();
      366 |   });

      at tests/tty.test.js:363:41

  ● getColorDepth() › getColorDepth({"AGENT_NAME": "x", "TF_BUILD": "1"}) === 4

    expect(received).toBe(expected) // Object.is equality

    Expected: 1
    Received: 4

      361 |     // and it matches real node:tty exactly
      362 |     const r = new realTty.WriteStream(1);
    > 363 |     expect(s.getColorDepth({ ...env })).toBe(r.getColorDepth({ ...env }));
          |                                         ^
      364 |     s.destroy();
      365 |     r.destroy();
      366 |   });

      at tests/tty.test.js:363:41

  ● tty browser fallback (no native delegation) › honest platform color values

    expect(received).toBe(expected) // Object.is equality

    Expected: false
    Received: true

      497 |     const w = new fb.WriteStream(1);
      498 |     expect(w.getColorDepth({})).toBe(1);
    > 499 |     expect(w.hasColors()).toBe(false);
          |                           ^
      500 |     w.destroy();
      501 |   });
      502 | });

      at Object.<anonymous> (tests/tty.test.js:499:27)

FAIL tests/perf_hooks.test.js
  ● perf_hooks module surface › exports match Node v24.20.0 (no Histogram)

    expect(received).toEqual(expected) // deep equality

    - Expected  - 2
    + Received  + 0

    @@ -6,10 +6,8 @@
        "PerformanceObserver",
        "PerformanceObserverEntryList",
        "PerformanceResourceTiming",
        "constants",
        "createHistogram",
    -   "eventLoopUtilization",
        "monitorEventLoopDelay",
        "performance",
    -   "timerify",
      ]

      54 |     // The native namespace additionally carries a `default` key; the named
      55 |     // exports must otherwise match.
    > 56 |     expect(Object.keys(nativePerfHooks).filter((k) => k !== 'default').sort()).toEqual(
         |                                                                                ^
      57 |       expected.slice().sort(),
      58 |     );
      59 |     for (const name of expected) {

      at Object.<anonymous> (tests/perf_hooks.test.js:56:80)

FAIL tests/crypto.test.js
  ● crypto native bridge (node) › exports the full node:crypto surface

    expect(received).toBe(expected) // Object.is equality

    Expected: true
    Received: false

      30 |   test('exports the full node:crypto surface', () => {
      31 |     for (const name of EXPECTED_EXPORTS) {
    > 32 |       expect(typeof crypto[name] !== 'undefined').toBe(true);
         |                                                   ^
      33 |     }
      34 |   });
      35 |

      at Object.<anonymous> (tests/crypto.test.js:32:51)

FAIL tests/constants.test.js
  ● constants — port of node:constants (values captured from Node v24.20.0) › exports the same key set as the real builtin (236 keys + ESM default)

    expect(received).toEqual(expected) // deep equality

    - Expected  - 2
    + Received  + 2

    @@ -94,12 +94,10 @@
        "ETIME",
        "ETIMEDOUT",
        "ETXTBSY",
        "EWOULDBLOCK",
        "EXDEV",
    -   "EXTENSIONLESS_FORMAT_JAVASCRIPT",
    -   "EXTENSIONLESS_FORMAT_WASM",
        "F_OK",
        "OPENSSL_VERSION_NUMBER",
        "O_APPEND",
        "O_CREAT",
        "O_DIRECT",
    @@ -129,10 +127,11 @@
        "RSA_PKCS1_PADDING",
        "RSA_PKCS1_PSS_PADDING",
        "RSA_PSS_SALTLEN_AUTO",
        "RSA_PSS_SALTLEN_DIGEST",
        "RSA_PSS_SALTLEN_MAX_SIGN",
    +   "RSA_SSLV23_PADDING",
        "RSA_X931_PADDING",
        "RTLD_DEEPBIND",
        "RTLD_GLOBAL",
        "RTLD_LAZY",
        "RTLD_LOCAL",
    @@ -232,7 +231,8 @@
        "UV_FS_O_FILEMAP",
        "UV_FS_SYMLINK_DIR",
        "UV_FS_SYMLINK_JUNCTION",
        "W_OK",
        "X_OK",
    +   "defaultCipherList",
        "defaultCoreCipherList",
      ]

      12 |     const realKeys = Object.keys(real).sort();
      13 |     const shimKeys = Object.keys(shimNs).filter(k => k !== 'default').sort();
    > 14 |     expect(shimKeys).toEqual(realKeys);
         |                      ^
      15 |     expect(Object.keys(shimNs)).toHaveLength(237); // 236 named + default
      16 |   });
      17 |

      at Object.<anonymous> (tests/constants.test.js:14:22)

  ● constants — port of node:constants (values captured from Node v24.20.0) › differential: every key matches the real node:constants value

    expect(received).toStrictEqual(expected) // deep equality

    Expected: 0
    Received: undefined

      18 |   test('differential: every key matches the real node:constants value', () => {
      19 |     for (const k of Object.keys(real)) {
    > 20 |       expect(shimNs[k]).toStrictEqual(real[k]);
         |                         ^
      21 |     }
      22 |   });
      23 |

      at Object.<anonymous> (tests/constants.test.js:20:25)

  ● constants — port of node:constants (values captured from Node v24.20.0) › default export is the full namespace object and is frozen

    expect(received).toStrictEqual(expected) // deep equality

    Expected: 0
    Received: undefined

      26 |     expect(typeof shimDefault).toBe('object');
      27 |     for (const k of Object.keys(real)) {
    > 28 |       expect(shimDefault[k]).toStrictEqual(real[k]);
         |                              ^
      29 |     }
      30 |     // The real module freezes its exports object; we mirror that.
      31 |     expect(Object.isFrozen(real)).toBe(true);

      at Object.<anonymous> (tests/constants.test.js:28:30)

  ● constants — port of node:constants (values captured from Node v24.20.0) › cipher list strings are preserved verbatim

    expect(received).toBe(expected) // Object.is equality

    Expected: undefined
    Received: "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA"

      54 |     expect(typeof shimNs.defaultCoreCipherList).toBe('string');
      55 |     expect(shimNs.defaultCipherList).toContain('TLS_AES_256_GCM_SHA384');
    > 56 |     expect(shimNs.defaultCipherList).toBe(real.defaultCipherList);
         |                                      ^
      57 |   });
      58 | });
      59 |

      at Object.<anonymous> (tests/constants.test.js:56:38)

FAIL tests/v8.test.js (6.209 s)
  ● v8 shim › getCppHeapStatistics() › returns object with the real v24 key set

    TypeError: getCppHeapStatistics is not a function

      108 |   describe('getCppHeapStatistics()', () => {
      109 |     test('returns object with the real v24 key set', () => {
    > 110 |       const stats = getCppHeapStatistics();
          |                     ^
      111 |       expect(typeof stats.committed_size_bytes).toBe('number');
      112 |       expect(typeof stats.resident_size_bytes).toBe('number');
      113 |       expect(typeof stats.used_size_bytes).toBe('number');

      at Object.<anonymous> (tests/v8.test.js:110:21)

  ● v8 shim › getCppHeapStatistics() › honours the 'brief' detail level

    TypeError: getCppHeapStatistics is not a function

      118 |
      119 |     test("honours the 'brief' detail level", () => {
    > 120 |       expect(getCppHeapStatistics('brief').detail_level).toBe('brief');
          |              ^
      121 |     });
      122 |
      123 |     test('rejects an invalid detail level like Node', () => {

      at Object.<anonymous> (tests/v8.test.js:120:14)

  ● v8 shim › getCppHeapStatistics() › rejects an invalid detail level like Node

    expect(received).toThrow(expected)

    Expected asymmetric matcher: ObjectContaining {"code": "ERR_INVALID_ARG_VALUE"}

    Received name:    "TypeError"
    Received message: "getCppHeapStatistics is not a function"

          122 |
          123 |     test('rejects an invalid detail level like Node', () => {
        > 124 |       expect(() => getCppHeapStatistics('bogus')).toThrow(
              |                    ^
          125 |         expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }),
          126 |       );
          127 |     });

      at tests/v8.test.js:124:20
      at Object.<anonymous> (node_modules/expect/build/index.js:1824:9)
      at Object.throwingMatcher [as toThrow] (node_modules/expect/build/index.js:2235:93)
      at Object.<anonymous> (tests/v8.test.js:124:51)
      at Object.<anonymous> (tests/v8.test.js:124:51)


Test Suites: 8 failed, 41 passed, 49 total
Tests:       28 failed, 1666 passed, 1694 total
Snapshots:   0 total
Time:        10.783 s
Ran all test suites.
