import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withHostAgentJobLease } from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentJobUsageError, cmdAgentJob, runAgentJob, type RunAgentJobOptions } from './agent-job.js';
import { PROGRAM_HANDLERS } from './index.js';
import { buildProgram } from './program.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-agent-job-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function base(command: string[], log: (m: string) => void = () => {}): RunAgentJobOptions {
  return { command, job: 'rescue', repo: 'o/r', issue: 1, maxAgentJobs: 1, dir: join(dir, 'jobs'), log, pollMs: 25 };
}

async function leftovers(): Promise<string[]> {
  return (await readdir(join(dir, 'jobs'))).filter((f) => f.startsWith('slot-'));
}

describe('runAgentJob', () => {
  it('a second agent job waits for the lease, logs waiting for host agent job lease (1/1 in use), and starts only after the first ends', async () => {
    const events = join(dir, 'events.txt');
    const script = `const fs=require('fs');const t=process.argv[1];fs.appendFileSync(${JSON.stringify(events)},'start '+t+' '+Date.now()+'\\n');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(events)},'end '+t+' '+Date.now()+'\\n')},300)`;
    const logs: string[][] = [[], []];
    const codes = await Promise.all(
      ['a', 'b'].map((tag, i) => runAgentJob(base([process.execPath, '-e', script, tag], (m) => logs[i]!.push(m)))),
    );
    expect(codes).toEqual([0, 0]);
    const rows = (await readFile(events, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => {
        const [kind, tag, ts] = l.split(' ');
        return { kind, tag, ts: Number(ts) };
      });
    expect(rows).toHaveLength(4);
    const first = rows.find((r) => r.kind === 'start')!;
    const firstEnd = rows.find((r) => r.kind === 'end' && r.tag === first.tag)!;
    const second = rows.find((r) => r.kind === 'start' && r.tag !== first.tag)!;
    expect(second.ts).toBeGreaterThanOrEqual(firstEnd.ts);
    expect(logs.flat()).toContain('waiting for host agent job lease (1/1 in use)');
    expect(await leftovers()).toEqual([]);
  });

  it("releases the lease and returns the child's exit code when the job exits 0, exits non-zero, or fails to spawn", async () => {
    expect(await runAgentJob(base([process.execPath, '-e', '']))).toBe(0);
    expect(await leftovers()).toEqual([]);
    expect(await runAgentJob(base([process.execPath, '-e', 'process.exit(3)']))).toBe(3);
    expect(await leftovers()).toEqual([]);
    const logs: string[] = [];
    expect(await runAgentJob(base([join(dir, 'no-such-binary')], (m) => logs.push(m)))).toBe(127);
    expect(logs.some((m) => m.startsWith('could not start '))).toBe(true);
    expect(await leftovers()).toEqual([]);
  });

  it('returns 1 when the child is killed by a signal', async () => {
    expect(await runAgentJob(base([process.execPath, '-e', "process.kill(process.pid, 'SIGKILL')"]))).toBe(1);
    expect(await leftovers()).toEqual([]);
  });
});

describe('cmdAgentJob usage errors', () => {
  it('rejects an empty command, a bad --kind and a bad --issue', async () => {
    await expect(cmdAgentJob([], {})).rejects.toBeInstanceOf(AgentJobUsageError);
    await expect(cmdAgentJob(['true'], { kind: 'bogus' })).rejects.toBeInstanceOf(AgentJobUsageError);
    await expect(cmdAgentJob(['true'], { issue: 'x' })).rejects.toBeInstanceOf(AgentJobUsageError);
    await expect(cmdAgentJob(['true'], { issue: '-2' })).rejects.toBeInstanceOf(AgentJobUsageError);
  });
});

describe('cmdAgentJob', () => {
  beforeEach(() => {
    vi.stubEnv('FACTORY_HOST_AGENT_JOBS_DIR', join(dir, 'jobs'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs the command inside a lease in the host agent jobs dir and returns the child's exit code", async () => {
    expect(
      await cmdAgentJob([process.execPath, '-e', 'process.exit(4)'], { kind: 'steward', repo: 'o/r', issue: '7' }),
    ).toBe(4);
    expect(await leftovers()).toEqual([]);
  });

  it('logs to stderr while it waits for a lease held by another job', async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      let releaseHolder!: () => void;
      const held = new Promise<void>((r) => (releaseHolder = r));
      let holderStarted!: () => void;
      const started = new Promise<void>((r) => (holderStarted = r));
      const holder = withHostAgentJobLease(
        { dir: join(dir, 'jobs'), maxAgentJobs: 1, repo: 'o/r', issue: 1, job: 'rescue', log: () => {}, pollMs: 25 },
        async () => {
          holderStarted();
          await held;
        },
      );
      await started;
      const waiting = cmdAgentJob([process.execPath, '-e', ''], {});
      await vi.waitFor(() => expect(stderr.join('')).toContain('factory agent-job: waiting for host agent job lease'));
      releaseHolder();
      await holder;
      expect(await waiting).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('falls back to the default config when it is not run inside a git repo', async () => {
    vi.stubEnv('GIT_DIR', join(dir, 'not-a-repo'));
    expect(await cmdAgentJob([process.execPath, '-e', ''], {})).toBe(0);
    expect(await leftovers()).toEqual([]);
  });
});

describe('factory agent-job command', () => {
  let stderr: string[];

  beforeEach(() => {
    vi.stubEnv('FACTORY_HOST_AGENT_JOBS_DIR', join(dir, 'jobs'));
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  const run = (args: string[]) =>
    buildProgram(PROGRAM_HANDLERS, {}).parseAsync(['node', 'factory', 'agent-job', ...args]);

  it("sets the process exit code to the command's exit code", async () => {
    await run(['--', process.execPath, '-e', 'process.exit(5)']);
    expect(process.exitCode).toBe(5);
  });

  it('prints a usage error and exits 2 for a bad --kind', async () => {
    await run(['--kind', 'bogus', '--', process.execPath, '-e', '']);
    expect(process.exitCode).toBe(2);
    expect(stderr.join('')).toContain('--kind must be rescue or steward, got "bogus"');
  });
});
