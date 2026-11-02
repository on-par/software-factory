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

const DEPRECATED_SIZE_GATE_MODES = new Set<unknown>(['file', 'slice']);

/** Maps the raw deprecated `file` and `slice` inputs to `stack`, warning once per call; other values pass through (#3832). */
export function aliasDeprecatedSizeGateMode<T>(mode: T, warn: (line: string) => void = console.warn): T | 'stack' {
  if (!DEPRECATED_SIZE_GATE_MODES.has(mode)) return mode;
  warn(sizeGateDeprecationLine(String(mode)));
  return 'stack';
}

const warnedSizeGateConfigs = new WeakSet();

/** sizeGate.mode from the factory config; missing or unknown resolves to `stack`, `file` and `slice` alias to it with one warning per config. */
export function resolveSizeGateMode(config: FactoryConfig): SizeGateMode {
  const raw = config.sizeGate?.mode;
  if (DEPRECATED_SIZE_GATE_MODES.has(raw)) {
    if (warnedSizeGateConfigs.has(config)) return 'stack';
    warnedSizeGateConfigs.add(config);
    return aliasDeprecatedSizeGateMode(raw) as SizeGateMode;
  }
  return parseSizeGateMode(raw) ?? 'stack';
}

/** True when the config sets sizeGate.mode to exactly `stack` (#3832). */
export function isExplicitStackMode(config: FactoryConfig): boolean {
  return config.sizeGate?.mode === 'stack';
}
