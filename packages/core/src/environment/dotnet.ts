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

/** .NET lane isolation for a .NET worktree root:
 *  - DOTNET_TieredPGO=0 — Dynamic PGO tiers up the Razor source generator after ~4
 *    compiles and produces wrong output.
 *  - MSBUILDDISABLENODEREUSE=1 — MSBuild nodes exit at build end instead of being
 *    reused by other lanes or the user's shell.
 *  - SharedCompilationId=factory-<runId> — a VBCSCompiler server private to this run
 *    (omitted when runId is absent). It exits on its own idle timeout; the factory
 *    never shuts down compiler servers.
 *  Each key already set in the parent environment wins (children inherit it), so
 *  that key alone is omitted. */
export function dotnetEnv(
  root: string,
  parentEnv: Record<string, string | undefined> = process.env,
  runId?: string,
): Record<string, string> {
  if (!isDotnetWorktree(root)) return {};
  const wanted: Record<string, string> = { DOTNET_TieredPGO: '0', MSBUILDDISABLENODEREUSE: '1' };
  if (runId) wanted.SharedCompilationId = `factory-${runId}`;
  return Object.fromEntries(Object.entries(wanted).filter(([k]) => parentEnv[k] === undefined));
}
