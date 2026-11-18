/**
 * Little-endian bit writer.
 * Writes bits LSB-first within bytes.
 */
export class BitWriter {
    chunks = [];
    currentByte = 0;
    bitOffset = 0; // 0-7, bits written in current byte
    /** Write n bits (1-32), LSB first */
    writeBits(n, bits) {
        if (n < 1 || n > 32) {
            throw new RangeError(`BitWriter.writeBits: n must be 1-32, got ${n}`);
        }
        const mask = n === 32 ? 0xffff_ffff : (1 << n) - 1;
        let value = (bits >>> 0) & mask;
        let bitsLeft = n;
        while (bitsLeft > 0) {
            const spaceInByte = 8 - this.bitOffset;
            const take = Math.min(bitsLeft, spaceInByte);
            const maskTake = (1 << take) - 1;
            this.currentByte |= (value & maskTake) << this.bitOffset;
            this.bitOffset += take;
            bitsLeft -= take;
            value >>= take;
            if (this.bitOffset >= 8) {
                this.chunks.push(this.currentByte & 0xff);
                this.currentByte = 0;
                this.bitOffset = 0;
            }
        }
    }
    /** Flush remaining bits to output. Call when done writing. */
    flush() {
        const result = [...this.chunks];
        if (this.bitOffset > 0) {
            result.push(this.currentByte & 0xff);
        }
        return new Uint8Array(result);
    }
    /** Reset writer for reuse */
    reset() {
        this.chunks = [];
        this.currentByte = 0;
        this.bitOffset = 0;
    }
}