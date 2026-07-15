// packages/core/src/utils/command-runner.ts — shared argv-based command runner (no shell)
import { execa } from 'execa';

export interface RunCommandOptions {
  cwd?: string;
  /** Milliseconds. Always ms — call sites must not pass seconds. */
  timeoutMs?: number;
  maxBuffer?: number;
  env?: Record<string, string>;
}

export interface CommandResult {
  /** The argv that ran, for diagnostics. */
  command: readonly string[];
  stdout: string;
  stderr: string;
  /** -1 when the process produced no exit code (spawn failure or killed). */
  exitCode: number;
  /** True when the process was terminated by a signal (incl. timeout kill). */
  killed: boolean;
  /** True when terminated because timeoutMs elapsed. */
  timedOut: boolean;
  /** exitCode === 0 && !killed && !timedOut */
  ok: boolean;
}

export async function runCommand(
  argv: readonly string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  if (argv.length === 0 || argv[0].trim() === '') {
    throw new TypeError('runCommand: argv must be non-empty and argv[0] must not be blank');
  }

  const r = await execa(argv[0], argv.slice(1), {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    env: options.env,
    extendEnv: true,
    reject: false,
    all: false,
  });

  const exitCode = typeof r.exitCode === 'number' ? r.exitCode : -1;
  const killed = r.isTerminated === true;
  const timedOut = r.timedOut === true;
  const stdout = typeof r.stdout === 'string' ? r.stdout : '';
  const stderr = r.failed && typeof r.exitCode !== 'number'
    ? (r.shortMessage ?? '')
    : (typeof r.stderr === 'string' ? r.stderr : '');

  return {
    command: argv,
    stdout,
    stderr,
    exitCode,
    killed,
    timedOut,
    ok: exitCode === 0 && !killed && !timedOut,
  };
}

/** First non-empty of stderr, stdout, or an exit-code note — for FAIL details. */
export function describeCommandFailure(r: CommandResult): string {
  return r.stderr || r.stdout || (r.timedOut ? `timed out` : `exit code ${r.exitCode}`);
}
