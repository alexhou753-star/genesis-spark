/** @genesis/engine 统一出口 */
export type { GameState, StateMeta, PermaState, RunState, GameCommand, CommandResult } from './types.js';
export type { SimResult, SegmentBudget, SimState, EventSource } from './advance.js';
export type { SimEvent, EventGroup } from './events.js';
export { DeterminismError } from './events.js';
export { mulberry32, secToTicks, fastPowInt, deterministicLn1p } from './math.js';
export { advance, assertInvariants } from './advance.js';
export { resourceBoundarySource, groupRank, GROUP_ORDER } from './events.js';
export { createDispatchState, dispatch, recoverFromWal } from './dispatch.js';
export { hashState, hashReplay, canonicalize, fnv1a64Hex } from './hash.js';
export type { RngStream } from './types.js';
