if(!globalThis.primordials){
import primordials from "./per_context/primordials.js"; // using plugin namespace
}
import * as b from "https://github.com/nodejs/node/blob/main/lib/internal/errors.js"; // using plugin namespace

export * from "https://github.com/nodejs/node/blob/main/lib/internal/errors.js"; // named exports
export { b as default }; // default export
