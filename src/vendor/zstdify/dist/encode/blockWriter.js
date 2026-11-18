/**
 * Write raw and RLE blocks.
 */
let sharedHeader = null;
function writeU24LE(arr, offset, value) {
    arr[offset] = value & 0xff;
    arr[offset + 1] = (value >> 8) & 0xff;
    arr[offset + 2] = (value >> 16) & 0xff;
}
function getHeader() {
    if (!sharedHeader)
        sharedHeader = new Uint8Array(3);
    return sharedHeader;
}
export function writeRawBlock(data, offset, size, last) {
    const header = getHeader();
    const blockHeader = (last ? 1 : 0) | (0 << 1) | (size << 3);
    writeU24LE(header, 0, blockHeader);
    const result = new Uint8Array(3 + size);
    result.set(header);
    result.set(data.subarray(offset, offset + size), 3);
    return result;
}
export function writeRLEBlock(byte, size, last) {
    const header = getHeader();
    const blockHeader = (last ? 1 : 0) | (1 << 1) | (size << 3);
    writeU24LE(header, 0, blockHeader);
    const result = new Uint8Array(4);
    result.set(header, 0);
    result[3] = byte & 0xff;
    return result;
}