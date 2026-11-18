/**
 * LSB-first bit writer used for reverse zstd bitstreams.
 * Callers must write symbols in reverse decode order.
 */
export class ReverseBitWriter {
    buffer = new Uint8Array(0);
    outputSize = 0;
    writePos = 0;
    bitContainer = 0;
    bitCount = 0;
    reset(bitLength) {
        this.outputSize = (bitLength + 7) >>> 3;
        if (this.buffer.length < this.outputSize) {
            this.buffer = new Uint8Array(this.outputSize);
        }
        this.buffer.fill(0, 0, this.outputSize);
        this.writePos = 0;
        this.bitContainer = 0;
        this.bitCount = 0;
    }
    writeBits(n, bits) {
        let remaining = n;
        let value = bits >>> 0;
        while (remaining > 0) {
            // Keep shifts <= 31 bits for stable JS bitwise semantics.
            const take = remaining > 24 ? 24 : remaining;
            const partMask = ((1 << take) - 1) >>> 0;
            const part = value & partMask;
            this.bitContainer |= part << this.bitCount;
            this.bitCount += take;
            value >>>= take;
            remaining -= take;
            while (this.bitCount >= 8) {
                this.buffer[this.writePos++] = this.bitContainer & 0xff;
                this.bitContainer >>>= 8;
                this.bitCount -= 8;
            }
        }
    }
    finish() {
        if (this.bitCount > 0 && this.writePos < this.outputSize) {
            this.buffer[this.writePos++] = this.bitContainer & 0xff;
            this.bitContainer = 0;
            this.bitCount = 0;
        }
        return this.buffer.slice(0, this.outputSize);
    }
}
export function encodeReverseBitstream(bitCounts, bitValues, writer = new ReverseBitWriter()) {
    let bitLength = 1; // End marker bit.
    for (let i = 0; i < bitCounts.length; i++) {
        const n = bitCounts[i] ?? 0;
        if (n > 0)
            bitLength += n;
    }
    writer.reset(bitLength);
    for (let i = bitCounts.length - 1; i >= 0; i--) {
        const n = bitCounts[i] ?? 0;
        if (n > 0)
            writer.writeBits(n, bitValues[i] ?? 0);
    }
    writer.writeBits(1, 1);
    return writer.finish();
}