// packages/core/src/config/policy.ts — the settings API's allow-list of repo policy fields
// safe for the dashboard to edit, plus the resolver that reports each field's effective
// value and the source that decided it (flag > env > config > packaged default) and the
// writer that persists one allow-listed field into `.factory/config.json`. See ADR-0094:
// this allow-list IS the authorization model for the loopback settings write surface.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { isPlainObject, loadFactoryConfig } from './index.js';

export type PolicySource = 'flag' | 'config' | 'env' | 'default';

export type SafePolicyFieldId = 'merge.auto' | 'merge.admin';

/** A distinct-confirmation gate for enabling a field: `setSafeRepoPolicyField` refuses to
 *  write until the caller echoes back `token`, and `auditText` is the one string shared by
 *  the daemon's AUDIT log line and the dashboard's post-save banner, so the two can't drift
 *  (#1390). The token is a deliberate-action ceremony, not a credential — loopback binding
 *  is still the authorization model (ADR-0094/0096). */
export interface PolicyConfirmation {
  token: string;
  auditText: string;
}

export interface SafePolicyFieldSpec {
  id: SafePolicyFieldId;
  label: string;
  description: string;
  configPath: readonly string[];
  envVar: string;
  flag: string;
  /** true: an env var of '1' forces the value on even when the config key is present —
   *  `merge.auto`'s legacy `config.merge.auto || FACTORY_MERGE === '1'` OR read. Omitted/
   *  false: a present config value is authoritative over the env var, matching
   *  `resolveMergePolicy`'s `run.merge.admin` read. */
  envForcesValue?: boolean;
  /** Present only for fields where *enabling* requires the distinct confirmation gate. */
  confirmEnable?: PolicyConfirmation;
}

export const SAFE_POLICY_FIELDS: readonly SafePolicyFieldSpec[] = [
  {
    id: 'merge.auto',
    label: 'Auto-merge',
    description: 'Squash-merge a shipped PR automatically once CI is green.',
    configPath: ['merge', 'auto'],
    envVar: 'FACTORY_MERGE',
    flag: '--merge',
    envForcesValue: true,
  },
  {
    id: 'merge.admin',
    label: 'Admin-merge (bypass required checks)',
    description: 'Merge a shipped PR using GitHub admin privileges even when required checks have not passed.',
    configPath: ['run', 'merge', 'admin'],
    envVar: 'FACTORY_MERGE_ADMIN',
    flag: '--admin-merge',
    confirmEnable: {
      token: 'ENABLE_ADMIN_MERGE_BYPASS',
      auditText: 'admin-merge bypass explicitly enabled — required checks can be skipped when merging',
    },
  },
];

/** The confirmation an *enable* of `id` requires, or undefined when none is needed
 *  (disabling, or a field with no `confirmEnable` gate). */
export function policyConfirmationFor(id: SafePolicyFieldId, value: boolean): PolicyConfirmation | undefined {
  if (!value) return undefined;
  return SAFE_POLICY_FIELDS.find((f) => f.id === id)?.confirmEnable;
}

export class PolicyConfirmationRequiredError extends Error {
  constructor(public readonly confirmation: PolicyConfirmation) {
    super(`confirmation required: ${confirmation.auditText}`);
    this.name = 'PolicyConfirmationRequiredError';
  }
}

export interface EffectivePolicyField {
  id: SafePolicyFieldId;
  label: string;
  description: string;
  value: boolean;
  source: PolicySource;
  sourceDetail: string;
  editable: boolean;
  /** Copied from the field's spec — present when *enabling* this field requires the
   *  distinct confirmation gate, so the UI can show its copy without a second field. */
  confirmEnable?: PolicyConfirmation;
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
    const base = {
      id: field.id,
      label: field.label,
      description: field.description,
      ...(field.confirmEnable ? { confirmEnable: field.confirmEnable } : {}),
    };

    const flagValue = flags[field.id];
    if (flagValue !== undefined) {
      return { ...base, value: flagValue, source: 'flag', sourceDetail: field.flag, editable: false };
    }

    const envForced = () => ({
      ...base,
      value: true,
      source: 'env' as const,
      sourceDetail: `env: ${field.envVar}=1`,
      editable: false,
    });

    // `merge.auto`'s engine read is `config.merge.auto || FACTORY_MERGE === '1'`: an
    // explicit FACTORY_MERGE=1 forces the value on regardless of the file. Other fields
    // (e.g. `merge.admin`, via `resolveMergePolicy`) treat a present config value as
    // authoritative over the env var instead — see `envForcesValue` on the spec.
    if (field.envForcesValue && env[field.envVar] === '1') {
      return envForced();
    }

    const rawValue = raw === null ? undefined : readAtPath(raw, field.configPath);
    if (typeof rawValue === 'boolean') {
      return { ...base, value: rawValue, source: 'config', sourceDetail: field.configPath.join('.'), editable: true };
    }

    if (env[field.envVar] === '1') {
      return envForced();
    }

    const defaults = loadFactoryConfig();
    const defaultValue = Boolean(isPlainObject(defaults) ? readAtPath(defaults, field.configPath) : undefined);
    return { ...base, value: defaultValue, source: 'default', sourceDetail: 'built-in default', editable: true };
  });

  return { configPath, fields };
}

export interface SetSafeRepoPolicyFieldOptions {
  env?: NodeJS.ProcessEnv;
  /** Must equal the field's `confirmEnable.token` when enabling a confirmation-gated
   *  field, or the write is refused before anything touches disk (#1390). */
  confirmationToken?: string;
}

export function setSafeRepoPolicyField(
  configPath: string,
  id: SafePolicyFieldId,
  value: boolean,
  options: SetSafeRepoPolicyFieldOptions = {},
): SafeRepoPolicySnapshot {
  const { env = process.env, confirmationToken } = options;
  const field = SAFE_POLICY_FIELDS.find((f) => f.id === id);
  if (!field) throw new Error(`Unknown safe policy field: ${id}`);

  const confirmation = policyConfirmationFor(id, value);
  if (confirmation && confirmationToken !== confirmation.token) {
    throw new PolicyConfirmationRequiredError(confirmation);
  }

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
