import { buildFastMatcherSequences } from './fastMatcher.js';
import { buildLazyMatcherSequences } from './lazyMatcher.js';
import { buildOptimalParserSequences } from './optimalParser.js';
export function buildGreedySequences(input, options) {
    const strategy = options?.strategy ?? 'fast';
    if (strategy === 'lazy') {
        return buildLazyMatcherSequences(input, {
            history: options?.history,
            repOffsets: options?.repOffsets,
            plannerState: options?.plannerState,
        });
    }
    if (strategy === 'optimal') {
        return buildOptimalParserSequences(input, {
            history: options?.history,
            repOffsets: options?.repOffsets,
            plannerState: options?.plannerState,
        });
    }
    return buildFastMatcherSequences(input, {
        history: options?.history,
        repOffsets: options?.repOffsets,
        plannerState: options?.plannerState,
    });
}