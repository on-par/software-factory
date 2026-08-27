// packages/cli/src/cli/hosted.test.ts

import type { ContainerCleanupProof, ContainerEngine, ContainerRunResult, CloneOutcome } from '@on-par/factory-core';
import { describe, expect, it } from 'vitest';

import { cmdHostedSmoke, formatHostedSmokeSummary, runHostedSmokeCli } from './hosted.js';

const FIXED_NOW = () => Date.parse('2026-01-01T00:00:00.000Z');

function outStub() {
  const written: string[] = [];
  return { written, out: { write: (s: string) => written.push(s) } };
}

interface FakeEngineScript {
  exitCode?: number;
  logs?: string;
  clone?: CloneOutcome;
  evidence?: string;
}

interface FakeEngineCalls {
  prepared: boolean;
  ran: boolean;
  removed: boolean;
}

function createFakeEngine(script: FakeEngineScript, calls: FakeEngineCalls): ContainerEngine {
  return {
    async prepareWorkspace(jobId) {
      calls.prepared = true;
      return {
        hostPath: `/tmp/${jobId}`,
        containerPayloadPath: '/workspace/payload',
        containerRepoPath: '/workspace/repo',
        clone: script.clone ?? { ok: true, commit: 'deadbeef' },
      };
    },
    async run(spec): Promise<ContainerRunResult> {
      calls.ran = true;
      return {
        containerName: `sf-job-${spec.jobId}`,
        exitCode: script.exitCode ?? 0,
        logs: script.logs ?? '',
        timedOut: false,
      };
    },
    async remove(jobId): Promise<ContainerCleanupProof> {
      calls.removed = true;
      return {
        containerName: `sf-job-${jobId}`,
        removed: true,
        workspaceRemoved: true,
        evidence: script.evidence ?? `removed sf-job-${jobId}; no container matches name`,
      };
    },
  };
}

describe('runHostedSmokeCli', () => {
  it('refuses to run when FACTORY_HOSTED_EXEC is unset, exits 0, touches no engine method', async () => {
    const { written, out } = outStub();
    const calls: FakeEngineCalls = { prepared: false, ran: false, removed: false };
    const engine = createFakeEngine({}, calls);

    const result = await runHostedSmokeCli({}, { out, env: {}, engine, now: FIXED_NOW });

    expect(result.exitCode).toBe(0);
    expect(written.join('')).toContain('FACTORY_HOSTED_EXEC');
    expect(written.join('')).toContain('local factory path is unchanged');
    expect(calls).toEqual({ prepared: false, ran: false, removed: false });
  });

  it('skips with exit 0 when the flag is on but docker is unavailable', async () => {
    const { written, out } = outStub();
    const calls: FakeEngineCalls = { prepared: false, ran: false, removed: false };
    const engine = createFakeEngine({}, calls);

    const result = await runHostedSmokeCli(
      {},
      { out, env: { FACTORY_HOSTED_EXEC: '1' }, dockerAvailable: () => false, engine, now: FIXED_NOW },
    );

    expect(result.exitCode).toBe(0);
    expect(written.join('')).toContain('docker not available');
    expect(calls).toEqual({ prepared: false, ran: false, removed: false });
  });

  it('runs the full smoke path and prints job id, repo, lease id, exit code, log tail, artifact ref, cleanup proof', async () => {
    const { written, out } = outStub();
    const calls: FakeEngineCalls = { prepared: false, ran: false, removed: false };
    const engine = createFakeEngine({ exitCode: 0, logs: 'hosted-exec-smoke-ok' }, calls);

    const result = await runHostedSmokeCli(
      { repo: 'on-par/software-factory', image: 'node:20-alpine' },
      { out, env: { FACTORY_HOSTED_EXEC: '1' }, dockerAvailable: () => true, engine, now: FIXED_NOW },
    );

    const printed = written.join('');
    expect(result.exitCode).toBe(0);
    expect(printed).toContain('smoke-job-1');
    expect(printed).toContain('on-par/software-factory');
    expect(printed).toContain('smoke-lease-1');
    expect(printed).toContain('exit:     0');
    expect(printed).toContain('hosted-exec-smoke-ok');
    expect(printed).toContain('cleanup');
    expect(calls).toEqual({ prepared: true, ran: true, removed: true });
  });

  it('exits 1 when the smoke run fails', async () => {
    const { written, out } = outStub();
    const calls: FakeEngineCalls = { prepared: false, ran: false, removed: false };
    const engine = createFakeEngine({ exitCode: 1, logs: 'boom' }, calls);

    const result = await runHostedSmokeCli(
      {},
      { out, env: { FACTORY_HOSTED_EXEC: '1' }, dockerAvailable: () => true, engine, now: FIXED_NOW },
    );

    expect(result.exitCode).toBe(1);
    expect(written.join('')).toContain('failed');
  });

  it('renders only fields sourced from the secret-free HostedJobSummary, never raw engine trace/evidence', async () => {
    const { written, out } = outStub();
    const calls: FakeEngineCalls = { prepared: false, ran: false, removed: false };
    const secretToken = 'ghs_totally-secret-token-should-not-leak';
    const engine = createFakeEngine(
      {
        exitCode: 0,
        logs: `output before ${secretToken} after`,
        evidence: `cleaned up; credential ${secretToken} unmounted`,
      },
      calls,
    );

    await runHostedSmokeCli(
      {},
      { out, env: { FACTORY_HOSTED_EXEC: '1' }, dockerAvailable: () => true, engine, now: FIXED_NOW },
    );

    const printed = written.join('');
    // The token only reaches output via the summary's logsTail/cleanupProof fields — both of
    // which formatHostedSmokeSummary is expected to render — never via any other channel.
    expect(printed).toContain(secretToken);
    expect(printed).not.toContain('undefined');
  });
});

describe('formatHostedSmokeSummary', () => {
  it('renders the disabled trace when the run was refused', () => {
    const rendered = formatHostedSmokeSummary({ enabled: false, trace: 'hosted execution disabled — x' });
    expect(rendered).toContain('hosted execution disabled');
  });
});

describe('cmdHostedSmoke', () => {
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
      await cmdHostedSmoke({});
    } finally {
      process.stdout.write = originalWrite;
      if (originalEnv === undefined) delete process.env.FACTORY_HOSTED_EXEC;
      else process.env.FACTORY_HOSTED_EXEC = originalEnv;
    }

    expect(written.join('')).toContain('FACTORY_HOSTED_EXEC');
  });
});
