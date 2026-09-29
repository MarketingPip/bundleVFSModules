"use strict";

require("../common");
const assert = require("assert");
const { isUtf8, Buffer } = require("buffer");
const { TextEncoder } = require("util");

const encoder = new TextEncoder();

assert.strictEqual(isUtf8(encoder.encode("hello")), true);
assert.strictEqual(isUtf8(encoder.encode("ğ")), true);
assert.strictEqual(isUtf8(Buffer.from([])), true);

// Taken from test/fixtures/wpt/encoding/textdecoder-fatal.any.js
[
  [0xff], // 'invalid code'
  [0xc0], // 'ends early'
  [0xe0], // 'ends early 2'
  [0xc0, 0x00], // 'invalid trail'
  [0xc0, 0xc0], // 'invalid trail 2'
  [0xe0, 0x00], // 'invalid trail 3'
  [0xe0, 0xc0], // 'invalid trail 4'
  [0xe0, 0x80, 0x00], // 'invalid trail 5'
  [0xe0, 0x80, 0xc0], // 'invalid trail 6'
  [0xfc, 0x80, 0x80, 0x80, 0x80, 0x80], // '> 0x10FFFF'
  [0xfe, 0x80, 0x80, 0x80, 0x80, 0x80], // 'obsolete lead byte'

  // Overlong encodings
  [0xc0, 0x80], // 'overlong U+0000 - 2 bytes'
  [0xe0, 0x80, 0x80], // 'overlong U+0000 - 3 bytes'
  [0xf0, 0x80, 0x80, 0x80], // 'overlong U+0000 - 4 bytes'
  [0xf8, 0x80, 0x80, 0x80, 0x80], // 'overlong U+0000 - 5 bytes'
  [0xfc, 0x80, 0x80, 0x80, 0x80, 0x80], // 'overlong U+0000 - 6 bytes'

  [0xc1, 0xbf], // 'overlong U+007F - 2 bytes'
  [0xe0, 0x81, 0xbf], // 'overlong U+007F - 3 bytes'
  [0xf0, 0x80, 0x81, 0xbf], // 'overlong U+007F - 4 bytes'
  [0xf8, 0x80, 0x80, 0x81, 0xbf], // 'overlong U+007F - 5 bytes'
  [0xfc, 0x80, 0x80, 0x80, 0x81, 0xbf], // 'overlong U+007F - 6 bytes'

  [0xe0, 0x9f, 0xbf], // 'overlong U+07FF - 3 bytes'
  [0xf0, 0x80, 0x9f, 0xbf], // 'overlong U+07FF - 4 bytes'
  [0xf8, 0x80, 0x80, 0x9f, 0xbf], // 'overlong U+07FF - 5 bytes'
  [0xfc, 0x80, 0x80, 0x80, 0x9f, 0xbf], // 'overlong U+07FF - 6 bytes'

  [0xf0, 0x8f, 0xbf, 0xbf], // 'overlong U+FFFF - 4 bytes'
  [0xf8, 0x80, 0x8f, 0xbf, 0xbf], // 'overlong U+FFFF - 5 bytes'
  [0xfc, 0x80, 0x80, 0x8f, 0xbf, 0xbf], // 'overlong U+FFFF - 6 bytes'

  [0xf8, 0x84, 0x8f, 0xbf, 0xbf], // 'overlong U+10FFFF - 5 bytes'
  [0xfc, 0x80, 0x84, 0x8f, 0xbf, 0xbf], // 'overlong U+10FFFF - 6 bytes'

  // UTF-16 surrogates encoded as code points in UTF-8
  [0xed, 0xa0, 0x80], // 'lead surrogate'
  [0xed, 0xb0, 0x80], // 'trail surrogate'
  [0xed, 0xa0, 0x80, 0xed, 0xb0, 0x80], // 'surrogate pair'
].forEach((input) => {
  assert.strictEqual(isUtf8(Buffer.from(input)), false);
});

[null, undefined, "hello", true, false].forEach((input) => {
  assert.throws(
    () => {
      isUtf8(input);
    },
    {
      code: "ERR_INVALID_ARG_TYPE",
    },
  );
});

{
  // Test with detached array buffers
  const arrayBuffer = new ArrayBuffer(1024);
  structuredClone(arrayBuffer, { transfer: [arrayBuffer] });
  assert.throws(
    () => {
      isUtf8(arrayBuffer);
    },
    {
      code: "ERR_INVALID_STATE",
    },
  );
}
