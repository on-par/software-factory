// src/environment/dotnet.ts — .NET worktree detection and runtime env for lanes.
// Bounded nested detection (root + 3 levels); replaceable by toolchain discovery (#1896).

import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

const DOTNET_MARKER_EXTENSIONS = ['.sln', '.slnx', '.csproj', '.fsproj', '.vbproj'];
const DOTNET_SKIP_DIRS = new Set(['node_modules', 'bin', 'obj', '.git']);
const DOTNET_MAX_DEPTH = 3;

/** True when `root`, or a directory up to 3 levels below it, contains a *.sln, *.slnx, *.csproj,
 *  *.fsproj, *.vbproj or global.json file (case-insensitive). node_modules, bin, obj and .git are
 *  skipped and symlinks are not followed. The one .NET detector for the lane env and egress (#3472).
 *  Never throws: a missing or unreadable directory is not .NET. */
export function detectDotnetProject(root: string): boolean {
  if (root === '') return false;
  let level: string[] = [root];
  for (let depth = 0; depth <= DOTNET_MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile()) {
          const name = e.name.toLowerCase();
          if (name === 'global.json' || DOTNET_MARKER_EXTENSIONS.some((ext) => name.endsWith(ext))) return true;
        } else if (e.isDirectory() && !DOTNET_SKIP_DIRS.has(e.name.toLowerCase())) {
          next.push(join(dir, e.name));
        }
      }
    }
    level = next;
  }
  return false;
}

/** What dotnetEnv applied for a .NET worktree, and which wanted keys the parent env already set. */
export interface DotnetEnvReport {
  applied: Record<string, string>;
  parentKept: string[];
}

/** .NET lane env for a .NET worktree root:
 *  - DOTNET_TieredPGO=0 — Dynamic PGO tiers up the Razor source generator after ~4
 *    compiles and produces wrong output.
 *  - MSBUILDDISABLENODEREUSE=1 — MSBuild nodes exit at build end instead of being
 *    reused by other lanes or the user's shell.
 *  - SharedCompilationId=factory-<runId> — a VBCSCompiler server private to this run
 *    (omitted when runId is absent). It exits on its own idle timeout; the factory
 *    never shuts down compiler servers.
 *  - DiffEngine_Disabled=true — Verify/DiffEngine never launches a diff tool such as
 *    ImageMagick compare.
 *  - DOTNET_CLI_TELEMETRY_OPTOUT=1 and DOTNET_NOLOGO=1 — no telemetry or first-run
 *    banner noise.
 *  Each key already set in the parent environment wins (children inherit it), so
 *  that key alone goes to `parentKept` instead of `applied`. Null for a non-.NET root. */
export function dotnetEnvReport(
  root: string,
  parentEnv: Record<string, string | undefined> = process.env,
  runId?: string,
): DotnetEnvReport | null {
  if (!detectDotnetProject(root)) return null;
  const wanted: Record<string, string> = { DOTNET_TieredPGO: '0', MSBUILDDISABLENODEREUSE: '1' };
  if (runId) wanted.SharedCompilationId = `factory-${runId}`;
  wanted.DiffEngine_Disabled = 'true';
  wanted.DOTNET_CLI_TELEMETRY_OPTOUT = '1';
  wanted.DOTNET_NOLOGO = '1';
  const applied: Record<string, string> = {};
  const parentKept: string[] = [];
  for (const [k, v] of Object.entries(wanted)) {
    if (parentEnv[k] === undefined) applied[k] = v;
    else parentKept.push(k);
  }
  return { applied, parentKept };
}

/** The .NET lane variables for `root` (see dotnetEnvReport); {} for a non-.NET root. */
export function dotnetEnv(
  root: string,
  parentEnv: Record<string, string | undefined> = process.env,
  runId?: string,
): Record<string, string> {
  return dotnetEnvReport(root, parentEnv, runId)?.applied ?? {};
}

/** Event text for a report: the applied KEY=value pairs and any keys kept from the parent. */
export function describeDotnetEnv(report: DotnetEnvReport): string {
  const pairs = Object.entries(report.applied).map(([k, v]) => `${k}=${v}`);
  const applied = `applied .NET variables: ${pairs.length > 0 ? pairs.join(', ') : 'none'}`;
  return report.parentKept.length > 0 ? `${applied}; kept from parent: ${report.parentKept.join(', ')}` : applied;
}
