// packages/cli/src/cli/init-files.ts — the race-free file writes behind
// `factory init`: add `.factory/` to `.git/info/exclude` and seed the sample
// queue. Each one acts on the file directly and handles ENOENT/EEXIST instead
// of checking existsSync first, so nothing can change between check and use.

import { readFileSync, writeFileSync } from 'node:fs';

export const SAMPLE_QUEUE = `# factory queue — "<lane> <issue#>", priority-ordered.
# Lanes run in parallel; issues within a lane run serially.
# Put issues that touch the same files in the same lane.
# Example:
#   app 61
#   docs 66
`;

function errCode(err: unknown): unknown {
  return err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
}

/** Append `.factory/` to the git exclude file, creating it when absent.
 *  Returns false when the entry was already there. */
export function ensureFactoryExcluded(excludeFile: string): boolean {
  let content = '';
  try {
    content = readFileSync(excludeFile, 'utf-8');
  } catch (err) {
    if (errCode(err) !== 'ENOENT') throw err;
  }
  if (content.includes('.factory/')) return false;
  writeFileSync(excludeFile, content + (content.endsWith('\n') ? '' : '\n') + '.factory/\n');
  return true;
}

/** Write the sample queue only when no queue file exists. Returns false when
 *  one was already there (it is never overwritten). */
export function writeSampleQueue(queueFile: string): boolean {
  try {
    writeFileSync(queueFile, SAMPLE_QUEUE, { flag: 'wx' });
    return true;
  } catch (err) {
    if (errCode(err) === 'EEXIST') return false;
    throw err;
  }
}
