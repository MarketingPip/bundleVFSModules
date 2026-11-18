import { planSequences } from './sequencePlanner.js';
export function buildFastMatcherSequences(input, options) {
    return planSequences(input, {
        history: options?.history,
        repOffsets: options?.repOffsets,
        plannerState: options?.plannerState,
        chainLimit: 8,
        repScoreBonus: [48, 24, 12],
        lazyDepth: 0,
        searchWindow: 1,
    });
}