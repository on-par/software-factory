import { runCommand } from './command-runner.js';

const MIN_GH_VERSION = '2.103.0';

const REQUIRED = `gh ${MIN_GH_VERSION} or newer is required for gh pr edit --attach`;

export async function checkGhVersion(run: typeof runCommand = runCommand): Promise<string | undefined> {
  const r = await run(['gh', '--version']);
  const failure = r.exitCode === -1 ? 'gh was not found on PATH' : `gh --version failed (exit ${r.exitCode})`;
  if (!r.ok) return `${failure}; ${REQUIRED}`;
  const match = /gh version (\d+\.\d+\.\d+)/.exec(r.stdout);
  if (!match) return `could not read a version from gh --version; ${REQUIRED}`;
  const older = match[1].localeCompare(MIN_GH_VERSION, 'en', { numeric: true }) < 0;
  return older ? `gh ${match[1]} found, but ${REQUIRED}` : undefined;
}
