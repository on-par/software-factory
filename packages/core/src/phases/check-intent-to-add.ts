import type { EventKind } from '../events/kinds.js';
import { execGit } from '../utils/git-exec.js';

const MAX_LOGGED_PATHS = 10;
const MAX_ERROR_DETAIL = 240;

function errorDetail(error: unknown): string {
  let detail: string;
  if (error instanceof Error) detail = error.message;
  else if (typeof error === 'string') detail = error;
  else {
    try {
      detail = JSON.stringify(error) ?? String(error);
    } catch {
      detail = 'unprintable error';
    }
  }
  return Array.from(detail, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  })
    .join('')
    .slice(0, MAX_ERROR_DETAIL);
}

export async function markBuildFilesIntentToAdd(
  worktree: string,
  log: (type: EventKind, msg: string) => void,
): Promise<void> {
  let candidates: string[] | undefined;
  try {
    const listing = await execGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: worktree });
    if (listing.stdout !== '' && !listing.stdout.endsWith('\0')) {
      throw new Error('git ls-files returned malformed NUL-delimited output');
    }
    candidates = listing.stdout.split('\0').filter((path) => path !== '');
  } catch (error) {
    log(
      'warn',
      `could not list untracked files before git add --intent-to-add --all in ${worktree}: ${errorDetail(error)}`,
    );
  }

  try {
    await execGit(['add', '--intent-to-add', '--all'], { cwd: worktree });
  } catch (error) {
    log('warn', `git add --intent-to-add --all failed in ${worktree}: ${errorDetail(error)}`);
    return;
  }

  if (candidates === undefined || candidates.length === 0) return;
  const displayed = candidates.slice(0, MAX_LOGGED_PATHS).map((path) => JSON.stringify(path));
  const remaining = candidates.length - displayed.length;
  log(
    'check',
    `marked build files intent-to-add: ${displayed.join(', ')}${remaining > 0 ? ` (+${remaining} more)` : ''}`,
  );
}
