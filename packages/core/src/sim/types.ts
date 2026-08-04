// packages/core/src/sim/types.ts — shared unions for the sim harness. Extracted from
// pipeline.ts so jitter.ts can key its config by phase without an import cycle.

export type SimTerminalState = 'shipped' | 'parked' | 'escalated';
export type SimPhaseName = 'plan' | 'build' | 'check' | 'ship';
