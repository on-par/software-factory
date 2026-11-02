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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** ADR-0160 warn stage (#3850): an unknown string sizeGate.mode runs as stack with a warning. */
export function sizeGateModeValueIssue(
  raw: Record<string, unknown>,
): { value: string; message: string; fix: string } | undefined {
  const gate = raw.sizeGate;
  if (!isRecord(gate) || !('mode' in gate)) return undefined;
  const value = gate.mode;
  if (typeof value !== 'string') return undefined; // non-strings are the schema's error to report
  if (parseSizeGateMode(value) !== undefined || DEPRECATED_SIZE_GATE_MODES.has(value)) return undefined;
  return {
    value,
    message: `sizeGate.mode is ${JSON.stringify(value)}, which is not one of off, stack; it runs as stack and will be an error in a later release`,
    fix: 'set sizeGate.mode to "off" or "stack" (exact, lowercase), or remove it (see docs/config.example.yaml)',
  };
}

const warnedSizeGatePaths = new Set<string>();

/** Loader warning (#3850): console.warn an unknown sizeGate.mode once per config path and value; true when the raw config has one. */
export function warnSizeGateModeOnce(configPath: string, raw: Record<string, unknown>): boolean {
  const issue = sizeGateModeValueIssue(raw);
  if (!issue) return false;
  const key = `${configPath}\0${issue.value}`;
  if (!warnedSizeGatePaths.has(key)) {
    warnedSizeGatePaths.add(key);
    console.warn(`factory: ${configPath}: ${issue.message}; ${issue.fix}`);
  }
  return true;
}

/** Marks a config as already warned so resolveSizeGateMode does not repeat the loader's line (#3850). */
export function markSizeGateModeWarned(config: FactoryConfig): void {
  warnedSizeGateConfigs.add(config);
}

/** sizeGate.mode from the factory config; missing or unknown resolves to `stack`. `file` and `slice` alias to it, and an
 *  unknown string mode warns (ADR-0160, #3850), each with one warning per config through `warn`. */
export function resolveSizeGateMode(config: FactoryConfig, warn: (line: string) => void = console.warn): SizeGateMode {
  const raw = config.sizeGate?.mode;
  if (DEPRECATED_SIZE_GATE_MODES.has(raw)) {
    if (warnedSizeGateConfigs.has(config)) return 'stack';
    warnedSizeGateConfigs.add(config);
    return aliasDeprecatedSizeGateMode(raw, warn) as SizeGateMode;
  }
  const issue = sizeGateModeValueIssue({ sizeGate: config.sizeGate });
  if (issue && !warnedSizeGateConfigs.has(config)) {
    warnedSizeGateConfigs.add(config);
    warn(`factory: ${issue.message}; ${issue.fix}`);
  }
  return parseSizeGateMode(raw) ?? 'stack';
}

/** True when the config sets sizeGate.mode to exactly `stack` (#3832). */
export function isExplicitStackMode(config: FactoryConfig): boolean {
  return config.sizeGate?.mode === 'stack';
}
