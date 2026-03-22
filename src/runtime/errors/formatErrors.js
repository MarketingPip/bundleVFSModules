/**
 * Parses an unhandledrejection event into structured info
 * @param {PromiseRejectionEvent} event
 */
export function parseError(event) {
  const stack = reason.stack || '';

  // Extract first stack frame location
  let locationStr = null;
  const stackLines = stack.split('\n');

  if (stackLines.length > 1) {
    const match = stackLines[1].match(/\(?(.+:\d+:\d+)\)?$/);
    if (match) locationStr = match[1];
  }

  // Parse location into file, line, column
  const { file, line, column } = parseStackLocation(locationStr);

  return {
    file,
    line,
    column,
    location: locationStr?.trim() || null
  };
}

/**
 * Parses a stack frame location string into file, line, column
 */
function parseStackLocation(location) {
  if (!location) return { file: null, line: null, column: null };

  const parts = location.split(':');

  return {
    file: parts[0]?.trim().replace(/^at\s+/,'') || null,
    line: parts[1] || null,
    column: parts[2] || null
  };
}
