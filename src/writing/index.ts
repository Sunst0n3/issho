// Public surface of the handwriting engine.
export { WritingPad, AUTO_HINT_AFTER, STYLUS_LENIENCY } from './WritingPad.tsx';
export type { RecallResult, WritingMode, WritingPadHandle, WritingPadProps, WritingResult } from './WritingPad.tsx';
export { StrokeAnimation, StrokeOrderStrip } from './StrokeOrder.tsx';
export { useStrokes } from './useStrokes.ts';
export type { StrokesState } from './useStrokes.ts';
export { estimateFrame, hungarian, matchCharacter, matchCharacterUnordered, matchStroke, matchStrokeOf, MISSING_COST } from './matcher.ts';
export type { CharacterMatch, Frame, MatchOptions, MismatchReason, StrokeAttempt, StrokeMatch, UnorderedMatch } from './matcher.ts';
export { describeStroke, mistakeMessage, orderNotes } from './describe.ts';
export type { OrderNote } from './describe.ts';
export { pathLength, samplePath } from './path.ts';
export type { Point } from './path.ts';
