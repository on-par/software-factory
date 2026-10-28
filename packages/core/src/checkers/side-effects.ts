import type { CheckerOutput } from '../types/index.js';
import { defaultIsProcessGroupAlive } from '../environment/process-groups.js';
import { execGit } from '../utils/git-exec.js';
import type { CheckerContext } from './index.js';
import type { EvidenceCommandLifecycle } from './evidence-plan.js';

export interface EvidenceSideEffectsGuard extends EvidenceCommandLifecycle {
  finish(options?: { evidenceFailed?: boolean }): Promise<CheckerOutput>;
  /** One line per evidence command that left live process groups (all were sent to killAll) (#3749). */
  leakReport(): string[];
}

interface StatusRecord {
  code: string;
  path: string;
  origin?: string;
}

function parseStatus(raw: string): StatusRecord[] {
  if (raw && !raw.endsWith('\0')) throw new Error('git status output is missing a NUL terminator');
  const tokens = raw ? raw.slice(0, -1).split('\0') : [];
  const records: StatusRecord[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.length < 4 || token[2] !== ' ') throw new Error('malformed git status record');
    const code = token.slice(0, 2);
    if (code === '  ' || !/^(?:\?\?|[ MADRCUT][ MADRCUT])$/.test(code))
      throw new Error(`unknown git status code ${JSON.stringify(code)}`);
    const path = token.slice(3);
    if (!path) throw new Error('malformed git status path');
    if (code.includes('R') || code.includes('C')) {
      const origin = tokens[++index];
      if (origin === undefined || origin === '') throw new Error('malformed rename/copy origin path');
      records.push({ code, path, origin });
    } else records.push({ code, path });
  }
  return records;
}

function exempt(path: string): boolean {
  return path === '.factory' || path.startsWith('.factory/');
}

function recordKey(record: StatusRecord): string {
  return JSON.stringify([record.code, record.path, record.origin]);
}

function recordPaths(record: StatusRecord): string[] {
  return [record.path, ...(record.origin === undefined ? [] : [record.origin])];
}

function describePath(path: string): string {
  return JSON.stringify(path);
}

export function createEvidenceSideEffectsGuard(
  ctx: CheckerContext,
  deps: { readStatus?: () => Promise<string>; isAlive?: (pgid: number) => boolean } = {},
): EvidenceSideEffectsGuard {
  const readStatus =
    deps.readStatus ??
    (async () =>
      (
        await execGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no'], {
          cwd: ctx.worktree,
        })
      ).stdout);
  const isAlive = deps.isAlive ?? defaultIsProcessGroupAlive;
  let before: StatusRecord[] | undefined;
  let activated = false;
  let beforeError: Error | undefined;
  let finalOutput: CheckerOutput | undefined;
  const findings = new Set<string>();
  const diagnostics = new Set<string>();
  const leaks = new Map<string, Set<number>>();

  const snapshot = async (): Promise<StatusRecord[]> => parseStatus(await readStatus());
  const fail = (diagnostic: string): void => {
    diagnostics.add(diagnostic);
  };

  const leakReport = (): string[] =>
    [...leaks].map(
      ([command, pgids]) =>
        `evidence command ${JSON.stringify(command)} left live process group${pgids.size > 1 ? 's' : ''} ${[...pgids].sort((a, b) => a - b).join(', ')} (cleaned up)`,
    );

  return {
    async beforeCommand() {
      if (beforeError) throw beforeError;
      if (activated) return;
      activated = true;
      try {
        before = await snapshot();
      } catch (error) {
        const message = `unable to capture pre-evidence worktree status: ${error instanceof Error ? error.message : String(error)}`;
        beforeError = new Error(message, { cause: error });
        fail(message);
        throw beforeError;
      }
    },
    async afterCommand(command, pgids) {
      for (const pgid of new Set(pgids)) {
        let alive: boolean;
        try {
          alive = isAlive(pgid);
        } catch (error) {
          fail(`could not probe process group ${pgid} after ${JSON.stringify(command)}: ${String(error)}`);
          continue;
        }
        if (!alive) continue;
        const leaked = leaks.get(command) ?? new Set<number>();
        leaked.add(pgid);
        leaks.set(command, leaked);
        if (!ctx.processGroupTracker) {
          fail(`no lane process tracker is available to clean process group ${pgid}`);
          continue;
        }
        try {
          await ctx.processGroupTracker.killAll();
        } catch (error) {
          fail(`cleanup failed for evidence command ${JSON.stringify(command)}: ${String(error)}`);
        }
      }
    },
    leakReport,
    async finish(options) {
      if (finalOutput) return finalOutput;
      if (!activated) {
        finalOutput = { checker: 'side_effects', result: 'SKIP', details: 'no evidence command executed' };
        return finalOutput;
      }
      if (beforeError) {
        finalOutput = { checker: 'side_effects', result: 'FAIL', details: [...diagnostics].join('\n') };
        return finalOutput;
      }
      try {
        const after = await snapshot();
        const original = new Set((before ?? []).map(recordKey));
        for (const record of after) {
          if (original.has(recordKey(record))) continue;
          for (const path of recordPaths(record)) if (!exempt(path)) findings.add(path);
        }
      } catch (error) {
        fail(
          `unable to verify post-evidence worktree status: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const details = [
        ...[...findings].sort().map((path) => `changed worktree path ${describePath(path)}`),
        ...(options?.evidenceFailed ? [] : leakReport()),
        ...diagnostics,
      ];
      finalOutput = {
        checker: 'side_effects',
        result: details.length ? 'FAIL' : 'PASS',
        details: details.join('\n') || 'no worktree or process side effects detected',
      };
      return finalOutput;
    },
  };
}
