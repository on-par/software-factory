// packages/core/src/config/policy.ts — the settings API's allow-list of repo policy fields
// safe for the dashboard to edit, plus the resolver that reports each field's effective
// value and the source that decided it (flag › repo › env › default, read straight from
// the engine's `resolveMergePolicy`) and the
// writer that persists one allow-listed field into the repo config file, in that file's own
// format (YAML edited in place, comments kept). See ADR-0094:
// this allow-list IS the authorization model for the loopback settings write surface.

import { isPlainObject, loadFactoryConfigForRepo, resolveMergePolicy } from './index.js';
import type { ConfigSource } from './precedence.js';
import { readRepoConfigFile, setRepoConfigValue } from './repo-config-file.js';

export type PolicySource = ConfigSource;

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
  /** The slot of `EffectiveMergePolicy` this field reads. */
  policyKey: 'auto' | 'admin';
  /** Present only for fields where *enabling* requires the distinct confirmation gate. */
  confirmEnable?: PolicyConfirmation;
}

export const SAFE_POLICY_FIELDS: readonly SafePolicyFieldSpec[] = [
  {
    id: 'merge.auto',
    label: 'Auto-merge',
    description: 'Squash-merge a shipped PR automatically once CI is green.',
    configPath: ['run', 'merge', 'auto'],
    policyKey: 'auto',
    envVar: 'FACTORY_MERGE',
    flag: '--auto-merge',
  },
  {
    id: 'merge.admin',
    label: 'Admin-merge (bypass required checks)',
    description: 'Merge a shipped PR using GitHub admin privileges even when required checks have not passed.',
    configPath: ['run', 'merge', 'admin'],
    policyKey: 'admin',
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
  const raw = readRepoConfigFile(configPath);
  if (raw === undefined) return null;
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid ${configPath}: expected a JSON object`);
  }
  return raw;
}

function sourceDetailFor(
  field: SafePolicyFieldSpec,
  source: PolicySource,
  config: ReturnType<typeof loadFactoryConfigForRepo>,
): string {
  switch (source) {
    case 'flag':
      return field.flag;
    case 'env':
      return `env: ${field.envVar}=1`;
    case 'default':
      return 'built-in default';
    case 'repo':
      // A legacy top-level `merge.auto: true` also counts as a repo signal for auto-merge.
      if (field.policyKey === 'auto' && config.run?.merge?.auto === undefined) return 'merge.auto';
      return field.configPath.join('.');
  }
}

export function resolveSafeRepoPolicy(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  flags: Partial<Record<SafePolicyFieldId, boolean>> = {},
): SafeRepoPolicySnapshot {
  readRawConfig(configPath);
  const config = loadFactoryConfigForRepo(configPath);
  const policy = resolveMergePolicy(config, env, { auto: flags['merge.auto'] });

  const fields = SAFE_POLICY_FIELDS.map((field): EffectivePolicyField => {
    const base = {
      id: field.id,
      label: field.label,
      description: field.description,
      ...(field.confirmEnable ? { confirmEnable: field.confirmEnable } : {}),
    };

    // `resolveMergePolicy` has no admin override, so an admin flag is applied here.
    const flagValue = flags[field.id];
    if (field.policyKey === 'admin' && flagValue !== undefined) {
      return { ...base, value: flagValue, source: 'flag', sourceDetail: field.flag, editable: false };
    }

    const value = policy[field.policyKey];
    const source = policy.sources[field.policyKey];
    const editable = source === 'repo' || source === 'default';
    return { ...base, value, source, sourceDetail: sourceDetailFor(field, source, config), editable };
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

  readRawConfig(configPath);

  setRepoConfigValue(configPath, field.configPath, value);

  return resolveSafeRepoPolicy(configPath, env);
}
