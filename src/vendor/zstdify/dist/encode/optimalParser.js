import { planSequences } from './sequencePlanner.js';
export function buildOptimalParserSequences(input, options) {
    return planSequences(input, {
        history: options?.history,
        repOffsets: options?.repOffsets,
        plannerState: options?.plannerState,
        chainLimit: 40,
        repScoreBonus: [80, 40, 20],
        lazyDepth: 0,
        searchWindow: 16,
    });
}