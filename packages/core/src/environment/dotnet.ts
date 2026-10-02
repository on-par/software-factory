// src/environment/dotnet.ts — .NET worktree detection and runtime env for lanes.
// Root-marker detection only; replaceable by toolchain discovery (#1896).

import { readdirSync } from 'node:fs';

const DOTNET_MARKER_EXTENSIONS = ['.sln', '.slnx', '.csproj'];

/** True when `root` directly contains a *.sln, *.slnx, *.csproj or global.json file.
 *  Never throws: a missing or unreadable directory is not a .NET worktree. */
export function isDotnetWorktree(root: string): boolean {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => {
    if (!e.isFile()) return false;
    const name = e.name.toLowerCase();
    return name === 'global.json' || DOTNET_MARKER_EXTENSIONS.some((ext) => name.endsWith(ext));
  });
}

/** Disables Dynamic PGO for .NET worktrees: it tiers up the Razor source generator
 *  after ~4 compiles and produces wrong output. A DOTNET_TieredPGO already set in
 *  the parent environment wins (children inherit it), so the key is omitted then. */
export function dotnetEnv(
  root: string,
  parentEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (parentEnv.DOTNET_TieredPGO !== undefined) return {};
  return isDotnetWorktree(root) ? { DOTNET_TieredPGO: '0' } : {};
}
