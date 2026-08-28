// packages/cli/src/cli/hosted-queue.test.ts

import type { HostedJobClient, HostedJobSummary, QueueAndTailOutcome } from '@on-par/factory-core';
import { describe, expect, it, vi } from 'vitest';

import { cmdHostedQueue, formatQueueAndTailOutcome, runHostedQueueCli } from './hosted-queue.js';

function outStub() {
  const written: string[] = [];
  return { written, out: { write: (s: string) => written.push(s) } };
}

function fakeSummary(overrides: Partial<HostedJobSummary> = {}): HostedJobSummary {
  return {
    jobId: 'job-1',
    repoSlug: 'on-par/software-factory',
    status: 'requested',
    leasedBy: null,
    outcome: null,
    summary: null,
    exitCode: null,
    failurePhase: null,
    eventCount: 1,
    lastEvent: null,
    artifacts: [],
    artifactCount: 0,
    logsTail: null,
    cleanupProof: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeClient(overrides: Partial<HostedJobClient> = {}): HostedJobClient {
  return {
    createJob: vi.fn().mockResolvedValue(fakeSummary()),
    getJob: vi.fn().mockResolvedValue(fakeSummary()),
    getEvents: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('runHostedQueueCli', () => {
  it('refuses to run and exits 0 when the hosted-exec flag is off', async () => {
    const { written, out } = outStub();
    const client = fakeClient();
    const { exitCode } = await runHostedQueueCli({}, { env: {}, out, client });

    expect(exitCode).toBe(0);
    expect(written.join('')).toMatch(/FACTORY_HOSTED_EXEC/);
    expect(written.join('')).toMatch(/local factory path is unchanged/);
    expect(client.createJob).not.toHaveBeenCalled();
  });

  it('queues and tails a job to done, printing the progression and cleanup proof, exiting 0', async () => {
    const { written, out } = outStub();
    const doneSummary = fakeSummary({
      status: 'done',
      outcome: 'completed',
      exitCode: 0,
      cleanupProof: 'workspace cleaned',
      artifacts: [{ name: 'build.log', kind: 'log', ref: 'artifacts/build.log' }],
      artifactCount: 1,
    });
    const events = [
      {
        jobId: 'job-1',
        type: 'requested' as const,
        ts: '2026-01-01T00:00:00.000Z',
        severity: 'info' as const,
        message: 'job requested',
      },
      {
        jobId: 'job-1',
        type: 'completed' as const,
        ts: '2026-01-01T00:01:00.000Z',
        severity: 'info' as const,
        message: 'job completed',
      },
    ];
    const client = fakeClient({
      createJob: vi.fn().mockResolvedValue(doneSummary),
      getEvents: vi.fn().mockResolvedValue(events),
    });

    const { exitCode } = await runHostedQueueCli(
      { repo: 'on-par/software-factory' },
      { env: { FACTORY_HOSTED_EXEC: '1' }, out, client },
    );

    expect(exitCode).toBe(0);
    expect(client.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ repoSlug: 'on-par/software-factory', requiredCapabilities: ['git', 'node'] }),
    );
    const text = written.join('');
    expect(text).toContain('job-1');
    expect(text).toContain('on-par/software-factory');
    expect(text).toContain('event:    [info] requested @ 2026-01-01T00:00:00.000Z — job requested');
    expect(text).toContain('event:    [info] completed @ 2026-01-01T00:01:00.000Z — job completed');
    expect(text).toContain('cleanup:  workspace cleaned');
  });

  it('renders the failure phase and bounded logs and exits 1 on a failed job, without leaking secrets', async () => {
    const { written, out } = outStub();
    const secretToken = 'ghs_supersecrettoken1234567890';
    const failedSummary = fakeSummary({
      status: 'failed',
      outcome: 'failed',
      exitCode: 1,
      failurePhase: 'run',
      logsTail: 'build step failed at line 42',
    });
    const client = fakeClient({ createJob: vi.fn().mockResolvedValue(failedSummary) });

    const { exitCode } = await runHostedQueueCli(
      { authority: `repo:read token=${secretToken}` },
      { env: { FACTORY_HOSTED_EXEC: '1' }, out, client },
    );

    expect(exitCode).toBe(1);
    const text = written.join('');
    expect(text).toContain('failure:  run');
    expect(text).toContain('logs:     build step failed at line 42');
    expect(text).not.toContain(secretToken);
  });

  it('exits 1 when the job is canceled', async () => {
    const { out } = outStub();
    const client = fakeClient({
      createJob: vi.fn().mockResolvedValue(fakeSummary({ status: 'canceled', outcome: 'canceled' })),
    });

    const { exitCode } = await runHostedQueueCli({}, { env: { FACTORY_HOSTED_EXEC: '1' }, out, client });

    expect(exitCode).toBe(1);
  });

  it('exits 1 on a non-terminal timeout', async () => {
    const { out } = outStub();
    const client = fakeClient({
      createJob: vi.fn().mockResolvedValue(fakeSummary({ status: 'requested' })),
      getJob: vi.fn().mockResolvedValue(fakeSummary({ status: 'running' })),
    });

    let now = 0;
    const { exitCode } = await runHostedQueueCli(
      { timeout: '10', pollInterval: '5' },
      {
        env: { FACTORY_HOSTED_EXEC: '1' },
        out,
        client,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );

    expect(exitCode).toBe(1);
  });
});

describe('cmdHostedQueue', () => {
  it('does not call process.exit when the flag is off (real deps, default exit path)', async () => {
    const originalEnv = process.env.FACTORY_HOSTED_EXEC;
    delete process.env.FACTORY_HOSTED_EXEC;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const written: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await cmdHostedQueue({});
    } finally {
      process.stdout.write = originalWrite;
      if (originalEnv === undefined) delete process.env.FACTORY_HOSTED_EXEC;
      else process.env.FACTORY_HOSTED_EXEC = originalEnv;
    }

    expect(written.join('')).toContain('FACTORY_HOSTED_EXEC');
  });
});

describe('formatQueueAndTailOutcome', () => {
  it('renders "(none)" placeholders for every null field and no events', () => {
    const outcome: QueueAndTailOutcome = {
      jobId: 'job-1',
      terminal: true,
      status: 'done',
      summary: fakeSummary({ status: 'done' }),
      events: [],
      trace: 'queued job-1 -> done',
    };
    const text = formatQueueAndTailOutcome(outcome);
    expect(text).toContain('job:      job-1');
    expect(text).toContain('outcome:  (none)');
    expect(text).toContain('exit:     (none)');
    expect(text).toContain('failure:  (none)');
    expect(text).toContain('logs:     (none)');
    expect(text).toContain('artifacts: (none)');
    expect(text).toContain('cleanup:  (none)');
  });

  it('joins multiple artifact refs', () => {
    const outcome: QueueAndTailOutcome = {
      jobId: 'job-1',
      terminal: true,
      status: 'done',
      summary: fakeSummary({
        status: 'done',
        artifacts: [
          { name: 'build.log', kind: 'log', ref: 'artifacts/build.log' },
          { name: 'coverage', kind: 'report', ref: 'artifacts/coverage' },
        ],
        artifactCount: 2,
      }),
      events: [],
      trace: 'queued job-1 -> done',
    };
    const text = formatQueueAndTailOutcome(outcome);
    expect(text).toContain('artifacts: build.log (log): artifacts/build.log, coverage (report): artifacts/coverage');
  });
});
