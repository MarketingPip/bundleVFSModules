// assert-strict.js
import assert from "assert";

// Use the strict version
const strict = assert.strict;

// Export strict as the default, and also named
export default strict;
export { strict as assert };
