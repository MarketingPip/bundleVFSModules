/**
 * Browser-compliant shim for import.meta.resolve
 * @param {string} specifier - The path to resolve (e.g., './utils.js')
 * @param {string} [parent=import.meta.url] - The base URL (defaults to current module)
 * @returns {string} - The absolute resolved URL string
 */
function __RUNTIME_RESOLVE__HANDLE(specifier, parent = 'file:') {
  try {
    // 1. The URL constructor handles relative './' and '../' 
    //    against the parent URL exactly like the spec.
    return new URL(specifier, parent).href;
  } catch (err) {
    // 2. The spec requires throwing a TypeError on resolution failure
    throw new TypeError(`Failed to resolve module specifier "${specifier}" relative to "${parent}"`);
  }
}

Object.defineProperty(__RUNTIME_RESOLVE__HANDLE, 'toString', {
  value: function() {
    return 'function resolve() { [native code] }';
  },
  writable: false,
  configurable: true
});

globalThis._RUNTIME_.__RUNTIME_RESOLVE__HANDLE = __RUNTIME_RESOLVE__HANDLE;
