export function blockGlobals(names) {

  const globalObj = typeof globalThis !== 'undefined' ? globalThis : window;
  
  if (!Array.isArray(names)) {
    throw new TypeError("names must be an array");
  }

  names.forEach(name => {
    // ignore non-string values
    if (typeof name !== "string" || name.trim() === "") return;

    // check if property exists on global object
    if (!(name in globalObj)) {
      return;
    }

    globalObj[name] = function() {
      throw new Error(`${name} is not defined`);
    };
  });
}
