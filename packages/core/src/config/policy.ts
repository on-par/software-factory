// packages/core/src/config/policy.ts — the settings API's allow-list of repo policy fields
// safe for the dashboard to edit, plus the resolver that reports each field's effective
// value and the source that decided it (flag > env > config > packaged default) and the
// writer that persists one allow-listed field into `.factory/config.json`. See ADR-0094:
// this allow-list IS the authorization model for the loopback settings write surface.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { isPlainObject, loadFactoryConfig } from './index.js';

export type PolicySource = 'flag' | 'config' | 'env' | 'default';

export type SafePolicyFieldId = 'merge.auto';

export interface SafePolicyFieldSpec {
  id: SafePolicyFieldId;
  label: string;
  description: string;
  configPath: readonly string[];
  envVar: string;
  flag: string;
}

export const SAFE_POLICY_FIELDS: readonly SafePolicyFieldSpec[] = [
  {
    id: 'merge.auto',
    label: 'Auto-merge',
    description: 'Squash-merge a shipped PR automatically once CI is green.',
    configPath: ['merge', 'auto'],
    envVar: 'FACTORY_MERGE',
    flag: '--merge',
  },
];

export interface EffectivePolicyField {
  id: SafePolicyFieldId;
  label: string;
  description: string;
  value: boolean;
  source: PolicySource;
  sourceDetail: string;
  editable: boolean;
}

export interface SafeRepoPolicySnapshot {
  configPath: string;
  fields: EffectivePolicyField[];
}

export function isSafePolicyFieldId(id: unknown): id is SafePolicyFieldId {
  return typeof id === 'string' && SAFE_POLICY_FIELDS.some((f) => f.id === id);
}

function readRawConfig(configPath: string): Record<string, unknown> | null {
  if (!existsSync(configPath)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${(err as Error).message}`);
  }
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid ${configPath}: expected a JSON object`);
  }
  return raw;
}

function readAtPath(raw: Record<string, unknown>, configPath: readonly string[]): unknown {
  let current: unknown = raw;
  for (const key of configPath) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function resolveSafeRepoPolicy(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  flags: Partial<Record<SafePolicyFieldId, boolean>> = {},
): SafeRepoPolicySnapshot {
  const raw = readRawConfig(configPath);

  const fields = SAFE_POLICY_FIELDS.map((field): EffectivePolicyField => {
    const base = { id: field.id, label: field.label, description: field.description };

    const flagValue = flags[field.id];
    if (flagValue !== undefined) {
      return { ...base, value: flagValue, source: 'flag', sourceDetail: field.flag, editable: false };
    }

    // The engine's read is `config.merge.auto || FACTORY_MERGE === '1'`: an explicit
    // FACTORY_MERGE=1 forces the value on regardless of the file; any other value lets
    // the file decide, so it is not treated as an env-sourced override here.
    if (env[field.envVar] === '1') {
      return {
        ...base,
        value: true,
        source: 'env',
        sourceDetail: `env: ${field.envVar}=1`,
        editable: false,
      };
    }

    const rawValue = raw === null ? undefined : readAtPath(raw, field.configPath);
    if (typeof rawValue === 'boolean') {
      return { ...base, value: rawValue, source: 'config', sourceDetail: field.configPath.join('.'), editable: true };
    }

    const defaultValue = Boolean(readAtPath(loadFactoryConfig() as unknown as Record<string, unknown>, field.configPath));
    return { ...base, value: defaultValue, source: 'default', sourceDetail: 'built-in default', editable: true };
  });

  return { configPath, fields };
}

export function setSafeRepoPolicyField(
  configPath: string,
  id: SafePolicyFieldId,
  value: boolean,
  env: NodeJS.ProcessEnv = process.env,
): SafeRepoPolicySnapshot {
  const field = SAFE_POLICY_FIELDS.find((f) => f.id === id);
  if (!field) throw new Error(`Unknown safe policy field: ${id}`);

  const raw = readRawConfig(configPath) ?? { version: 2 };

  const next: Record<string, unknown> = { ...raw };
  let cursor = next;
  for (let i = 0; i < field.configPath.length - 1; i++) {
    const key = field.configPath[i]!;
    const existing = cursor[key];
    const cloned: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
    cursor[key] = cloned;
    cursor = cloned;
  }
  const leafKey = field.configPath[field.configPath.length - 1]!;
  cursor[leafKey] = value;

  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, configPath);

  return resolveSafeRepoPolicy(configPath, env);
}
