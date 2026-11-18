import { planSequences } from './sequencePlanner.js';
export function buildLazyMatcherSequences(input, options) {
    return planSequences(input, {
        history: options?.history,
        repOffsets: options?.repOffsets,
        plannerState: options?.plannerState,
        chainLimit: 20,
        repScoreBonus: [64, 32, 16],
        lazyDepth: 2,
        searchWindow: 4,
    });
}