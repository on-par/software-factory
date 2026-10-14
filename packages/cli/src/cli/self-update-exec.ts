// packages/cli/src/cli/self-update-exec.ts — factoryd's runner for `factory self-update --to` (#2355)

/** The exec seam factoryd uses (daemon.ts LaunchctlExec). */
type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface SelfUpdateCommandResult {
  code: number;
  rolledBack: boolean;
  error: string | null;
}

function lastLine(text: string): string | null {
  return text.trimEnd().split('\n').at(-1) || null;
}

function parseLastJsonLine(stdout: string): Record<string, unknown> | null {
  const line = lastLine(stdout);
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Runs `node <cli> self-update <args> --json` and reads its last JSON line, falling back to stderr, then the exit code. */
export async function runSelfUpdateCommand(
  exec: Exec,
  cliEntrypoint: string,
  args: string[],
): Promise<SelfUpdateCommandResult> {
  const r = await exec(process.execPath, [cliEntrypoint, 'self-update', ...args, '--json']);
  const json = parseLastJsonLine(r.stdout);
  const error =
    (typeof json?.error === 'string' && json.error !== '' ? json.error : null) ??
    lastLine(r.stderr) ??
    (r.code === 0 ? null : `exit ${r.code}`);
  return { code: r.code, rolledBack: json?.rolledBack === true || json?.outcome === 'rolled-back', error };
}
