/**
 * Deterministic error type for zstd operations.
 */
export class ZstdError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'ZstdError';
        Object.setPrototypeOf(this, ZstdError.prototype);
    }
}