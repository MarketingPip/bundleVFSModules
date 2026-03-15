import { Writable } from 'readable-stream';

// In Node, WritableState is an internal class used for managing 
// the state of the stream. We export it for compatibility.
const WritableState = Writable.WritableState || class {};

/**
 * Converts a Web WritableStream to a Node Writable stream
 */
function fromWeb(webStream, options) {
  return Writable.fromWeb(webStream, options);
}

/**
 * Converts a Node Writable stream to a Web WritableStream
 */
function toWeb(nodeStream) {
  return Writable.toWeb(nodeStream);
}

export { Writable, WritableState, fromWeb, toWeb };
export default Writable;
