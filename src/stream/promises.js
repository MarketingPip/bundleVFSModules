import { ArrayPrototypePop, ArrayIsArray, Promise } from "./primordials.js";
import { isIterable, isNodeStream, isWebStream } from "./utils.js";
import { pipelineImpl as pl } from "./pipeline.js";
import { finished } from "./end-of-stream.js";

function pipeline(...streams) {
  return new Promise((resolve, reject) => {
    let signal;
    let end;
    const lastArg = streams[streams.length - 1];
    if (
      lastArg &&
      typeof lastArg === "object" &&
      !isNodeStream(lastArg) &&
      !isIterable(lastArg) &&
      !isWebStream(lastArg)
    ) {
      const options = ArrayPrototypePop(streams);
      signal = options.signal;
      end = options.end;
    }

    let lastStream = streams[streams.length - 1];
    if (streams.length === 1 && ArrayIsArray(streams[0])) {
      lastStream = streams[0][streams[0].length - 1];
    }

    const stream = pl(
      streams,
      (err, value) => {
        if (err) {
          reject(err);
        } else {
          resolve(value);
        }
      },
      { signal, end },
    );

    // Node 26: when the last stream is a function, pipeline() returns a
    // PassThrough proxy whose readable side nobody consumes — resume it so
    // the pump's writes can drain and pipeline() can complete.
    if (typeof lastStream === "function" && stream.readable) {
      stream.resume();
    }
  });
}

const promises = {
  finished,
  pipeline,
};

export default promises;
export { finished, pipeline };
