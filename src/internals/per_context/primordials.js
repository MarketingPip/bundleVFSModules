// primordials-wrapper.js
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Access Node's real internal primordials
const primordials = require('internal/per_context/primordials');

// Make sure it's available globally if needed
if (!globalThis.primordials) globalThis.primordials = primordials;

// Default export
export default primordials;

// Re-export all named properties individually
for (const key of Object.keys(primordials)) {
  if (!(key in exports)) {
    export const [key] = primordials[key];
  }
}
