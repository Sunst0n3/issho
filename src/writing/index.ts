// Public surface of the handwriting engine.
export { WritingPad, AUTO_HINT_AFTER, STYLUS_LENIENCY } from './WritingPad.tsx';
export type { WritingMode, WritingPadHandle, WritingPadProps, WritingResult } from './WritingPad.tsx';
export { StrokeAnimation, StrokeOrderStrip } from './StrokeOrder.tsx';
export { useStrokes } from './useStrokes.ts';
export type { StrokesState } from './useStrokes.ts';
export { estimateFrame, matchCharacter, matchStroke, matchStrokeOf } from './matcher.ts';
export type { CharacterMatch, Frame, MatchOptions, MismatchReason, StrokeAttempt, StrokeMatch } from './matcher.ts';
export { describeStroke, mistakeMessage } from './describe.ts';
export { pathLength, samplePath } from './path.ts';
export type { Point } from './path.ts';
