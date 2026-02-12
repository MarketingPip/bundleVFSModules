import { vol, promises, constants, fs as memfsFs } from "memfs";
import { createFsFromVolume } from "memfs";

// Create a Node-like fs object from the memfs volume
const fs = createFsFromVolume(vol);

// Attach the promises API (exact Node-style)
fs.promises = promises;

// Also attach constants (Node-style)
fs.constants = constants;

// Export the Node-like fs object and named exports
export default fs;
export { fs, promises, constants };
