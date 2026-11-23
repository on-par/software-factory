import { defaultFactoryConfig } from '@on-par/factory-config';

import type { FactoryConfig } from './index.js';

export const READINESS_JUDGE_MODES = ['enforce', 'advisory', 'off'] as const;
export type ReadinessJudgeMode = (typeof READINESS_JUDGE_MODES)[number];

function isReadinessJudgeMode(value: unknown): value is ReadinessJudgeMode {
  return (READINESS_JUDGE_MODES as readonly unknown[]).includes(value);
}

export function resolveReadinessJudgeMode(
  config: FactoryConfig,
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = console.warn,
): ReadinessJudgeMode {
  const configured = config.readiness?.judge ?? defaultFactoryConfig.readiness.judge;
  const raw = env.FACTORY_READINESS_JUDGE;
  if (raw === undefined) return configured;
  const fromEnv = raw.trim().toLowerCase();
  if (isReadinessJudgeMode(fromEnv)) return fromEnv;
  warn(
    `factory: FACTORY_READINESS_JUDGE=${JSON.stringify(raw)} is not one of ${READINESS_JUDGE_MODES.join(', ')}; it is ignored and readiness.judge (${configured}) applies`,
  );
  return configured;
}

const warnedReadinessLines = new Set<string>();

export function warnReadinessUpdateBodyOnce(
  configPath: string,
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = console.warn,
): void {
  const readiness = raw.readiness;
  const sources = [
    typeof readiness === 'object' && readiness !== null && 'updateIssueBody' in readiness
      ? 'readiness.updateIssueBody'
      : undefined,
    env.FACTORY_READINESS_UPDATE_BODY === undefined ? undefined : 'FACTORY_READINESS_UPDATE_BODY',
  ].filter((s): s is string => s !== undefined);
  if (sources.length === 0) return;
  const plural = sources.length > 1;
  const line = `factory: ${configPath}: ${sources.join(' and ')} ${plural ? 'are' : 'is'} deprecated and ignored: the factory never edits the ticket body (ADR-0167); remove ${plural ? 'them' : 'it'}`;
  if (warnedReadinessLines.has(line)) return;
  warnedReadinessLines.add(line);
  warn(line);
}
