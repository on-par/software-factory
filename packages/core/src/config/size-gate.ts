import type { FactoryConfig } from './index.js';

/**
 * sizeGate.mode values this build understands. `stack` (ADR-0161) is the default and only splitting mode; `off` skips
 * both gates. `file` and `slice` are deprecated raw inputs that alias to `stack` before validation (#3832, #3835). */
export const SIZE_GATE_MODES = ['off', 'stack'] as const;
export type SizeGateMode = (typeof SIZE_GATE_MODES)[number];

/** Exact match against SIZE_GATE_MODES; anything else is undefined. */
export function parseSizeGateMode(raw: unknown): SizeGateMode | undefined {
  return (SIZE_GATE_MODES as readonly unknown[]).includes(raw) ? (raw as SizeGateMode) : undefined;
}

/** The one-line warning for a deprecated size gate mode (#3832). */
export function sizeGateDeprecationLine(mode: string): string {
  return `factory: size gate mode '${mode}' is deprecated and runs as stack; use --stack (or sizeGate.mode: stack) (#3832)`;
}

/** The warning for an unknown size gate mode, which still falls back to stack for compatibility. */
export function sizeGateUnknownModeLine(mode: string): string {
  return `factory: unknown size gate mode '${mode}' runs as stack; allowed values: off, stack`;
}

const DEPRECATED_SIZE_GATE_MODES = new Set<unknown>(['file', 'slice']);

/** Maps the raw deprecated `file` and `slice` inputs to `stack`, warning once per call; other values pass through (#3832). */
export function aliasDeprecatedSizeGateMode<T>(mode: T, warn: (line: string) => void = console.warn): T | 'stack' {
  if (!DEPRECATED_SIZE_GATE_MODES.has(mode)) return mode;
  warn(sizeGateDeprecationLine(String(mode)));
  return 'stack';
}

const warnedSizeGateConfigs = new WeakSet();

/** sizeGate.mode from the factory config; missing resolves to `stack`, while deprecated and unknown values warn once per config. */
export function resolveSizeGateMode(config: FactoryConfig, warn: (line: string) => void = console.warn): SizeGateMode {
  const raw = config.sizeGate?.mode;
  if (DEPRECATED_SIZE_GATE_MODES.has(raw)) {
    if (warnedSizeGateConfigs.has(config)) return 'stack';
    warnedSizeGateConfigs.add(config);
    return aliasDeprecatedSizeGateMode(raw, warn) as SizeGateMode;
  }
  if (raw !== undefined && parseSizeGateMode(raw) === undefined) {
    if (!warnedSizeGateConfigs.has(config)) {
      warnedSizeGateConfigs.add(config);
      warn(sizeGateUnknownModeLine(String(raw)));
    }
    return 'stack';
  }
  return parseSizeGateMode(raw) ?? 'stack';
}

/** True when the config sets sizeGate.mode to exactly `stack` (#3832). */
export function isExplicitStackMode(config: FactoryConfig): boolean {
  return config.sizeGate?.mode === 'stack';
}
