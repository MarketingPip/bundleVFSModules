import { Writable } from "stream";

class WritableState {}

function fromWeb(stream) {
  return stream;
}

function toWeb(stream) {
  return stream;
}

export { Writable, WritableState, fromWeb, toWeb };
export default Writable;
