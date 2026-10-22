// src/sandbox/writable-paths.ts — validation and expansion of sandbox.writablePaths (#3454).
// Operator-listed extra writable directories must never defeat containment, so relative paths,
// the filesystem root, the home directory and anything equal to or containing the repo are refused.

import { isAbsolute, parse, relative, resolve } from 'node:path';

import { detectEcosystems, type Ecosystem } from './egress-proxy.js';

function expandWritablePath(entry: string, home: string): string | undefined {
  if (entry === '~' || entry.startsWith('~/')) return resolve(home, entry.slice(2));
  if (isAbsolute(entry)) return resolve(entry);
  return undefined;
}

/** Why a sandbox.writablePaths entry would defeat containment, or undefined when it is safe (#3454). */
export function writablePathError(entry: string, opts: { home: string; repoRoot?: string }): string | undefined {
  const resolved = expandWritablePath(entry, opts.home);
  if (resolved === undefined) return 'must be an absolute path or start with ~/';
  if (parse(resolved).root === resolved) return 'is the filesystem root';
  if (resolved === resolve(opts.home)) return 'is the home directory';
  if (opts.repoRoot !== undefined) {
    const rel = relative(resolved, resolve(opts.repoRoot));
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      return `equals or contains the primary repo checkout ${opts.repoRoot}`;
    }
  }
  return undefined;
}

function resolveWritableEntries(
  entries: readonly string[],
  opts: { home: string; repoRoot: string },
  label: string,
): string[] {
  const resolved: string[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    const why = writablePathError(entry, opts);
    const path = expandWritablePath(entry, opts.home);
    if (why !== undefined || path === undefined) problems.push(`${label} "${entry}" ${why}`);
    else resolved.push(path);
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
  return [...new Set(resolved)];
}

/** Resolves sandbox.writablePaths to absolute deduped paths; throws naming every bad entry. */
export function resolveConfiguredWritablePaths(
  entries: readonly string[] | undefined,
  opts: { home: string; repoRoot: string },
): string[] {
  return resolveWritableEntries(entries ?? [], opts, 'sandbox.writablePaths entry');
}

/** Writable dirs pre-allowed for a detected ecosystem (#3567); Node's ~/.npm is already a built-in. */
export const ECOSYSTEM_WRITABLE_PATHS: Readonly<Record<Ecosystem, readonly string[]>> = {
  node: [],
  dotnet: ['~/.nuget', '~/.dotnet'],
};

/** Absolute writable cache dirs for the ecosystems detected in repoDir, validated like operator entries (#3567). */
export function resolveEcosystemWritablePaths(repoDir: string, opts: { home: string; repoRoot: string }): string[] {
  const entries = detectEcosystems(repoDir).flatMap((eco) => ECOSYSTEM_WRITABLE_PATHS[eco]);
  return resolveWritableEntries(entries, opts, 'ecosystem default writable path');
}
