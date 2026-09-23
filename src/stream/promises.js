import {

  ArrayPrototypePop,
  Promise,
} from './primordials.js';
import {
  isIterable,
  isNodeStream,
  isWebStream,
} from './utils.js';
import { pipelineImpl as pl } from './pipeline.js';
import { finished } from './end-of-stream.js';










function pipeline(...streams) {
  return new Promise((resolve, reject) => {
    let signal;
    let end;
    const lastArg = streams[streams.length - 1];
    if (lastArg && typeof lastArg === 'object' &&
        !isNodeStream(lastArg) && !isIterable(lastArg) && !isWebStream(lastArg)) {
      const options = ArrayPrototypePop(streams);
      signal = options.signal;
      end = options.end;
    }

    pl(streams, (err, value) => {
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    }, { signal, end });
  });
}

const promises = {
  finished,
  pipeline,
};

export default promises;
export { finished, pipeline };
