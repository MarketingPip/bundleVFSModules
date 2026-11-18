import { readU32LE } from '../bitstream/littleEndian.js';
import { normalizeDecoderDictionary } from './decoderDictionary.js';
const ZSTD_DICTIONARY_MAGIC = 0xec30a437;
export function resolveDictionaryContextForCompression(dictionaryBytes, providedDictionaryId = null) {
    if (dictionaryBytes.length < 8 || readU32LE(dictionaryBytes, 0) !== ZSTD_DICTIONARY_MAGIC) {
        return {
            dictionaryId: providedDictionaryId,
            historyPrefix: dictionaryBytes,
            repOffsets: [1, 4, 8],
        };
    }
    const parsed = normalizeDecoderDictionary(dictionaryBytes, providedDictionaryId);
    return {
        dictionaryId: parsed.dictionaryId,
        historyPrefix: parsed.historyPrefix,
        repOffsets: [parsed.repOffsets[0], parsed.repOffsets[1], parsed.repOffsets[2]],
    };
}
export function resolveDictionaryIdForCompression(dictionaryBytes, providedDictionaryId = null) {
    return resolveDictionaryContextForCompression(dictionaryBytes, providedDictionaryId).dictionaryId;
}
export function resolveDictionaryHistoryForCompression(dictionaryBytes, providedDictionaryId = null) {
    return resolveDictionaryContextForCompression(dictionaryBytes, providedDictionaryId).historyPrefix;
}
export function resolveDictionaryRepOffsetsForCompression(dictionaryBytes, providedDictionaryId = null) {
    return resolveDictionaryContextForCompression(dictionaryBytes, providedDictionaryId).repOffsets;
}