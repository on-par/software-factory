// packages/cli/src/cli/init-files.ts — the race-free file writes behind
// `factory init`: drop the legacy `.factory/` line from `.git/info/exclude` and
// seed the sample queue. Each one acts on the file directly and handles ENOENT/EEXIST instead
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

/** Remove the bare `.factory/` (or `.factory`) line older inits added to the git
 *  exclude file, so `.factory/config.yaml` can be committed (#3689). Other lines are
 *  kept. A missing file is left missing. Returns true when a line was removed. */
export function healFactoryExclude(excludeFile: string): boolean {
  let content: string;
  try {
    content = readFileSync(excludeFile, 'utf-8');
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
  const lines = content.split('\n');
  const kept = lines.filter((line) => line.trim() !== '.factory/' && line.trim() !== '.factory');
  if (kept.length === lines.length) return false;
  writeFileSync(excludeFile, kept.join('\n'));
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
