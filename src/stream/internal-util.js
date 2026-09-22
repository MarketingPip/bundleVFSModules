// Exact ports of the internal/util helpers used by node:stream
// (from Node v24.20.0 lib/internal/util.js): once, kEmptyObject,
// assignFunctionName.

const kEmptyObject = Object.freeze({ __proto__: null });

function once(callback, { preserveReturnValue = false } = kEmptyObject) {
  let called = false;
  let returnValue;
  return function(...args) {
    if (called) return returnValue;
    called = true;
    const result = Reflect.apply(callback, this, args);
    returnValue = preserveReturnValue ? result : undefined;
    return result;
  };
}

function assignFunctionName(name, fn, descriptor = kEmptyObject) {
  if (typeof name !== 'string') {
    const symbolDescription = Object.getOwnPropertyDescriptor(name, 'description')?.value ??
      (typeof name === 'symbol' ? name.description : undefined);
    if (symbolDescription === undefined) {
      throw new Error('Attempted to name function after descriptionless Symbol');
    }
    name = `[${symbolDescription}]`;
  }
  return Object.defineProperty(fn, 'name', {
    __proto__: null,
    writable: false,
    enumerable: false,
    configurable: true,
    ...Object.getOwnPropertyDescriptor(fn, 'name'),
    ...descriptor,
    value: name,
  });
}

export {
  kEmptyObject,
  once,
  assignFunctionName,
};
