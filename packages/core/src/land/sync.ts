import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { parseAdr, upsertIndexRow } from '@on-par/adr-kit';
import type { EventKind } from '../events/kinds.js';
import type { FactoryEvent } from '../types/index.js';
import { shellEscape } from '../utils/index.js';

type LandCommandRunner = (command: string, options?: { cwd?: string; timeout?: number }) => Promise<unknown>;

export interface LandSyncOptions {
  worktree: string;
  branch: string;
  run: LandCommandRunner;
  log: (type: EventKind, msg: string, extra?: Pick<FactoryEvent, 'paths' | 'mode'>) => void;
}

export type LandSyncResult = { ok: true } | { ok: false; message: string; paths: string[] };

const TIMEOUT = 120_000;
const ADR_INDEX_PATH = 'docs/adr/README.md';
const ADR_FILE = /^docs\/adr\/[^/]+\.md$/i;
const NON_ADR = /^(readme|index|_?template)\.md$/i;

function output(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('stdout' in result)) {
    throw new Error('git inspection returned malformed stdout');
  }
  const stdout = (result as { stdout?: unknown }).stdout;
  if (typeof stdout !== 'string') throw new Error('git inspection returned malformed stdout');
  return stdout;
}

function pathsFromNul(text: string): string[] {
  return text.split('\0').filter(Boolean);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function syncLandBranch(opts: LandSyncOptions): Promise<LandSyncResult> {
  const run = (command: string) => opts.run(command, { cwd: opts.worktree, timeout: TIMEOUT });
  let mergeStarted = false;
  const abort = async (message: string, paths: string[] = []): Promise<LandSyncResult> => {
    if (mergeStarted) {
      try {
        await run('git merge --abort');
      } catch (error) {
        return { ok: false, message: `${message}; merge abort failed: ${errorText(error)}`, paths };
      }
    }
    return { ok: false, message, paths };
  };

  try {
    const status = output(await run('git status --porcelain -z'));
    if (status !== '') return { ok: false, message: 'worktree is dirty; refusing land sync', paths: [] };
    for (const marker of ['MERGE_HEAD', 'rebase-apply', 'rebase-merge']) {
      const check = await run(`git rev-parse --git-path ${shellEscape(marker)}`);
      const gitPath = output(check).trim();
      const found = await opts.run(`test -e ${shellEscape(gitPath)} && printf yes || printf no`, {
        cwd: opts.worktree,
        timeout: TIMEOUT,
      });
      const operationExists = output(found).trim();
      if (operationExists !== 'yes' && operationExists !== 'no') {
        throw new Error(`git operation inspection returned malformed stdout for ${marker}`);
      }
      if (operationExists === 'yes') {
        return { ok: false, message: `pre-existing git operation (${marker}); refusing land sync`, paths: [] };
      }
    }

    await run('git fetch origin');
    const head = output(await run('git rev-parse --verify HEAD')).trim();
    const base = output(await run('git merge-base HEAD origin/main')).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(head) || !/^[0-9a-f]{40,64}$/i.test(base)) {
      return { ok: false, message: 'could not identify pre-merge HEAD and merge base', paths: [] };
    }
    const addedPaths = pathsFromNul(
      output(await run(`git diff --diff-filter=A --name-only -z ${shellEscape(base)} HEAD -- docs/adr`)),
    )
      .filter((path) => ADR_FILE.test(path) && !NON_ADR.test(basename(path)))
      .sort();

    try {
      await run('git merge --no-edit origin/main');
    } catch (mergeError) {
      mergeStarted = true;
      let conflicts: string[];
      try {
        conflicts = pathsFromNul(output(await run('git diff --name-only --diff-filter=U -z'))).sort();
      } catch (inspectionError) {
        return await abort(`merge failed and conflict inspection failed: ${errorText(inspectionError)}`);
      }
      if (conflicts.length === 0) {
        return await abort(`merge failed without unmerged paths: ${errorText(mergeError)}`);
      }
      opts.log('conflict_detected', `land sync conflicts: ${conflicts.join(', ')}`, { paths: conflicts });
      const otherPaths = conflicts.filter((path) => path !== ADR_INDEX_PATH);
      if (otherPaths.length > 0) {
        return await abort(`unresolved merge conflicts: ${otherPaths.join(', ')}`, otherPaths);
      }

      let replayFailure: string | undefined;
      try {
        await run(`git checkout --theirs -- ${shellEscape(ADR_INDEX_PATH)}`);
        let readme = readFileSync(`${opts.worktree}/${ADR_INDEX_PATH}`, 'utf8');
        for (const path of addedPaths) {
          const filename = basename(path);
          const source = readFileSync(`${opts.worktree}/${path}`, 'utf8');
          const adr = parseAdr(source, { filename });
          const title = adr.title.trim();
          if (adr.number === undefined || title === '') {
            replayFailure = `${filename}: ADR requires a number and title`;
            break;
          }
          readme = upsertIndexRow(readme, { number: adr.number, title, status: adr.status, href: filename });
        }
        if (!replayFailure) {
          writeFileSync(`${opts.worktree}/${ADR_INDEX_PATH}`, readme);
          await run(`git add -- ${shellEscape(ADR_INDEX_PATH)}`);
          const remaining = pathsFromNul(output(await run('git diff --name-only --diff-filter=U -z'))).sort();
          if (remaining.length > 0) replayFailure = `unresolved paths remain: ${remaining.join(', ')}`;
          else await run('git commit --no-edit');
        }
      } catch (replayError) {
        replayFailure = errorText(replayError);
      }
      if (replayFailure) return await abort(`ADR index replay failed: ${replayFailure}`, [ADR_INDEX_PATH]);
    }

    try {
      await run(`git push origin ${shellEscape(opts.branch)}`);
    } catch (pushError) {
      return { ok: false, message: `push rejected: ${errorText(pushError)}`, paths: [] };
    }
    if (mergeStarted) {
      opts.log('conflict_resolved', 'resolved ADR index conflict mechanically', {
        mode: 'mechanical',
        paths: [ADR_INDEX_PATH],
      });
    }
    return { ok: true };
  } catch (error) {
    return abort(`land sync failed: ${errorText(error)}`);
  }
}
