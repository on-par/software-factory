import type { FactoryConfig } from './index.js';

/**
 * sizeGate.mode values this build understands (ADR-0147). `stack` (ADR-0161) is the default and ships a stacked PR set.
 * `file` and `slice` are deprecated aliases for `stack` (#3832). */
export const SIZE_GATE_MODES = ['file', 'slice', 'off', 'stack'] as const;
export type SizeGateMode = (typeof SIZE_GATE_MODES)[number];

/** Exact match against SIZE_GATE_MODES; anything else is undefined. */
export function parseSizeGateMode(raw: unknown): SizeGateMode | undefined {
  return (SIZE_GATE_MODES as readonly unknown[]).includes(raw) ? (raw as SizeGateMode) : undefined;
}

/** The one-line warning for a deprecated size gate mode (#3832). */
export function sizeGateDeprecationLine(mode: string): string {
  return `factory: size gate mode '${mode}' is deprecated and runs as stack; use --stack (or sizeGate.mode: stack) (#3832)`;
}

/** Maps the deprecated `file` and `slice` modes to `stack`, warning once per call; other modes pass through (#3832). */
export function aliasDeprecatedSizeGateMode(
  mode: SizeGateMode,
  warn: (line: string) => void = console.warn,
): SizeGateMode {
  if (mode !== 'file' && mode !== 'slice') return mode;
  warn(sizeGateDeprecationLine(mode));
  return 'stack';
}

const warnedSizeGateConfigs = new WeakSet();

/** sizeGate.mode from the factory config; missing or unknown resolves to `stack`, `file` and `slice` alias to it with one warning per config. */
export function resolveSizeGateMode(config: FactoryConfig): SizeGateMode {
  const mode = parseSizeGateMode(config.sizeGate?.mode);
  if (mode === undefined) return 'stack';
  if (mode !== 'file' && mode !== 'slice') return mode;
  if (warnedSizeGateConfigs.has(config)) return 'stack';
  warnedSizeGateConfigs.add(config);
  return aliasDeprecatedSizeGateMode(mode);
}

/** True when the config sets sizeGate.mode to exactly `stack` (#3832). */
export function isExplicitStackMode(config: FactoryConfig): boolean {
  return config.sizeGate?.mode === 'stack';
}
