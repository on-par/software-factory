import type { RepoFactoryConfig } from '../config/repo.js';

export type EvidenceAllowlist = ReadonlyMap<string, readonly string[]>;

const MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const LOCKFILES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'package-lock.json',
] as const;

export function tokenizeEvidenceCommand(text: string): readonly string[] | null {
  if (!text || /[\\\0\r\n|><;&`$*]/.test(text)) return null;
  const tokens: string[] = [];
  let token = '';
  let quote = '';
  let active = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = '';
      else token += char;
      active = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      active = true;
    } else if (char === ' ' || char === '\t') {
      if (active) tokens.push(token);
      token = '';
      active = false;
    } else {
      token += char;
      active = true;
    }
  }
  if (quote) return null;
  if (active) tokens.push(token);
  if (tokens.length === 0 || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) return null;
  return tokens;
}

function packageManager(value: unknown): (typeof MANAGERS)[number] | undefined {
  if (typeof value !== 'string' || !/^(npm|pnpm|yarn|bun)(?:@[^\s/]+)?$/.test(value)) return undefined;
  const manager = value.split('@', 1)[0];
  return MANAGERS.find((item) => item === manager);
}

function getManager(manifest: Record<string, unknown>, lockfiles: readonly string[]): (typeof MANAGERS)[number] {
  const explicit = packageManager(manifest.packageManager);
  if (explicit) return explicit;
  const lockfile = LOCKFILES.find((name) => lockfiles.includes(name));
  if (lockfile === 'pnpm-lock.yaml') return 'pnpm';
  if (lockfile === 'yarn.lock') return 'yarn';
  if (lockfile === 'bun.lock' || lockfile === 'bun.lockb') return 'bun';
  return 'npm';
}

export function resolveEvidenceAllowlist(
  packageJson: unknown,
  repoConfig: Pick<RepoFactoryConfig, 'commands' | 'checks'> | null | undefined,
  lockfiles: readonly string[] = [],
): EvidenceAllowlist {
  const result = new Map<string, readonly string[]>();
  const manifest =
    packageJson !== null && typeof packageJson === 'object' && !Array.isArray(packageJson)
      ? (packageJson as Record<string, unknown>)
      : {};
  const scripts =
    manifest.scripts !== null && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts)
      ? (manifest.scripts as Record<string, unknown>)
      : {};
  const manager = getManager(manifest, lockfiles);
  for (const [name, body] of Object.entries(scripts)) {
    if (isValidName(name) && typeof body === 'string') result.set(name, [manager, 'run', name]);
  }
  // Declared CHECK commands (`checks.build|test|lint`) beat same-named scripts; explicit `commands` beat both.
  for (const [name, body] of Object.entries(repoConfig?.checks ?? {})) {
    const argv = typeof body === 'string' ? tokenizeEvidenceCommand(body) : null;
    if (argv) result.set(name, argv);
  }
  const commands = repoConfig?.commands;
  if (commands && typeof commands === 'object') {
    for (const [name, body] of Object.entries(commands)) {
      result.delete(name);
      const argv = isValidName(name) ? tokenizeEvidenceCommand(body) : null;
      if (argv) result.set(name, argv);
    }
  }
  return result;
}

function isValidName(name: string): boolean {
  return NAME.test(name) && !RESERVED_NAMES.has(name);
}
