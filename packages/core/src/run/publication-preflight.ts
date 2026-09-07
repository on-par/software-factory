import { defaultExecFn, type ExecFn } from '../utils/exec.js';
import { shellEscape } from '../utils/index.js';

/** Probes the same origin/ref SHIP will use, without updating remote refs. */
export async function preflightPublication(options: {
  cwd: string;
  branch: string;
  exec?: ExecFn;
  timeoutMs?: number;
  onPgid?: (pgid: number) => void;
}): Promise<void> {
  try {
    await (options.exec ?? defaultExecFn)(
      `git push --dry-run --no-verify origin ${shellEscape(`HEAD:refs/heads/${options.branch}`)}`,
      {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs ?? 15_000,
        maxBuffer: 64 * 1024,
        killGraceMs: 100,
        onPgid: options.onPgid ?? (() => {}),
        env: {
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'Never',
          GIT_ASKPASS: '/usr/bin/false',
          SSH_ASKPASS: '/usr/bin/false',
          SSH_ASKPASS_REQUIRE: 'force',
        },
      },
    );
  } catch (error) {
    if ((error as { killed?: boolean } | null)?.killed) {
      throw Object.assign(
        new Error(
          'Git publication preflight timed out. Check the origin transport and credential helper on this computer before retrying.',
        ),
        { parkReason: 'timeout' },
      );
    }
    // Git and credential helpers may embed credentials in URLs or error output.
    // Keep their raw output out of persisted run events and model prompts.
    throw new Error(
      'Git publication preflight failed. Check origin push access and the Git credential helper or SSH identity on this computer; GitHub API login alone does not establish push access.',
    );
  }
}
