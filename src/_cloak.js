// src/_cloak.js — shared masking helpers for the native/monkey-patch rule.
//
// Jared's rule (2026-09-28, corrected): mask a shim function as
// `[native code]` IFF the corresponding real-Node builtin is genuinely
// native on Node v24 OR we monkey-patch it. Pure-JS reimplementations keep
// visible source — exactly like Node.
//
// Masking defines a non-enumerable, non-configurable, non-writable own
// `toString` on the function, so sandbox user code can neither see our
// source nor un-patch the mask. All helpers are idempotent.

const maskedSource = (name) => `function ${name}() { [native code] }`;

/**
 * Mask a single function as native. Skips non-functions, functions that
 * already carry an own `toString` (redefining a non-configurable property
 * throws), and functions that are already genuinely native (e.g. host
 * re-exports like URLPattern / MessageChannel) — no host objects are
 * ever mutated.
 */
export function maskAsNative(fn, key = fn.name) {
  if (typeof fn !== "function") return fn;
  if (Object.prototype.hasOwnProperty.call(fn, "toString")) return fn;
  if (/\[native code\]/.test(Function.prototype.toString.call(fn))) return fn;
  Object.defineProperty(fn, "toString", { value: () => maskedSource(key) });
  return fn;
}

/**
 * Mask named function-valued own properties of `obj` in place (preserves
 * function identity, so ESM named exports bound to the same objects stay
 * masked). Accessor descriptors and non-functions are left alone.
 */
export function maskMethodsAsNative(obj, ...keys) {
  if (obj === null || (typeof obj !== "object" && typeof obj !== "function"))
    return obj;
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc || desc.get || desc.set) continue;
    maskAsNative(desc.value, key);
  }
  return obj;
}

/**
 * Non-enumerable Symbol.toStringTag (browser-reality tags, e.g. 'Navigator').
 */
export function tagAs(obj, tag) {
  Object.defineProperty(obj, Symbol.toStringTag, {
    value: tag,
    enumerable: false,
    configurable: true,
  });
  return obj;
}
