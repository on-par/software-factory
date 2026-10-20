import { dirname } from 'node:path';

const DENIAL =
  /\b(?:sandbox\s+denied|operation\s+not\s+permitted|EACCES|EPERM|outside\s+the\s+writable|read-only\s+file\s+system)\b/i;
const PATH_CHARACTER = /[A-Za-z0-9_./\\-]/;

function mentionsDestination(output: string, destination: string): boolean {
  const normalized = destination.replace(/[\\/]+$/, '');
  if (normalized.length === 0) return false;

  let start = output.indexOf(normalized);
  while (start !== -1) {
    const before = output[start - 1];
    let end = start + normalized.length;
    while (output[end] === '/' || output[end] === '\\') end++;
    const after = output[end];
    if ((!before || !PATH_CHARACTER.test(before)) && (!after || !PATH_CHARACTER.test(after))) return true;
    start = output.indexOf(normalized, start + 1);
  }
  return false;
}

/** Detect a listed write denial only when the planner names this spec destination. */
export function specWriteDenied(output: string, specPath: string): boolean {
  if (!specPath || !DENIAL.test(output)) return false;
  return mentionsDestination(output, specPath) || mentionsDestination(output, dirname(specPath));
}

export function blockedNoChangeSpecReason(body: string): string | null {
  const looksBlocked = /^\s*Blocked(?::|\s+by\b)/im.test(body);
  if (!looksBlocked) return null;

  const saysNoChanges = /\bno files? (?:were )?changed\b/i.test(body) || /\bno changes? (?:were )?made\b/i.test(body);
  const pointsAtSandbox =
    /\bsandbox\b/i.test(body) || /\boutside (?:the )?(?:worktree|workspace|checkout)\b/i.test(body);
  if (!saysNoChanges && !pointsAtSandbox) return null;

  return 'PLAN returned a blocked/no-change note instead of a frozen spec';
}
