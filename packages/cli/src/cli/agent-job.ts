// packages/cli/src/cli/agent-job.ts — `factory agent-job -- <command...>` (#3047). Runs an ad-hoc rescue or
// steward command while holding a host agent job lease (host.maxAgentJobs, default 1), so such jobs do not
// pile onto lane builds. Waits (logging) for a free lease, releases it when the command ends, fails or cannot
// be spawned, and returns the child's exit code.

import { execFileSync, spawn } from 'node:child_process';

import { getFactoryPaths, loadFactoryConfig, loadFactoryConfigForRepo } from '@on-par/factory-core';
import {
  hostAgentJobsDir,
  resolveHostMaxAgentJobs,
  withHostAgentJobLease,
  type HostAgentJobKind,
} from '@on-par/factory-core/internal';

export class AgentJobUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentJobUsageError';
  }
}

export interface RunAgentJobOptions {
  /** [file, ...args], at least 1 entry. */
  command: string[];
  job: HostAgentJobKind;
  /** Holder label, '' when unknown. */
  repo: string;
  /** 0 when unknown. */
  issue: number;
  maxAgentJobs: number;
  /** hostAgentJobsDir() */
  dir: string;
  log: (message: string) => void;
  /** Forwarded to the lease poll; tests pass 25. */
  pollMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Runs the command inside the lease and returns its exit code (1 when killed by a signal, 127 when it cannot start). */
export async function runAgentJob(opts: RunAgentJobOptions): Promise<number> {
  const { command, job, repo, issue, maxAgentJobs, dir, log, pollMs, cwd, env } = opts;
  return withHostAgentJobLease({ dir, maxAgentJobs, repo, issue, job, log, pollMs }, () => {
    return new Promise<number>((resolve) => {
      const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit', cwd, env });
      child.on('error', (err) => {
        log(`could not start ${command[0]}: ${err.message}`);
        resolve(127);
      });
      child.on('close', (code) => resolve(code ?? 1));
    });
  });
}

function repoRootOrNull(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export async function cmdAgentJob(
  command: string[],
  opts: { kind?: string; repo?: string; issue?: string },
): Promise<number> {
  if (command.length === 0) {
    throw new AgentJobUsageError(
      'factory agent-job: pass the command after --, e.g. factory agent-job -- claude -p "..."',
    );
  }
  const kind = opts.kind ?? 'rescue';
  if (kind !== 'rescue' && kind !== 'steward') {
    throw new AgentJobUsageError(`factory agent-job: --kind must be rescue or steward, got "${kind}"`);
  }
  const issue = opts.issue === undefined ? 0 : Number(opts.issue);
  if (!Number.isInteger(issue) || issue < 0) {
    throw new AgentJobUsageError(`factory agent-job: --issue must be a non-negative integer, got "${opts.issue}"`);
  }
  const root = repoRootOrNull();
  const config = root ? loadFactoryConfigForRepo(getFactoryPaths(root).config) : loadFactoryConfig();
  return runAgentJob({
    command,
    job: kind,
    repo: opts.repo ?? '',
    issue,
    maxAgentJobs: resolveHostMaxAgentJobs(config),
    dir: hostAgentJobsDir(),
    log: (m) => process.stderr.write(`factory agent-job: ${m}\n`),
  });
}
