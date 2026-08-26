import { describe, expect, it } from 'vitest';

import {
  HOSTED_EXEC_FLAG,
  HostedArtifactRefSchema,
  HostedJobEventSchema,
  HostedJobRequestSchema,
  HostedJobResultSchema,
  ProviderSessionBundleSchema,
  RunnerLeaseSchema,
  hostedExecEnabled,
  runHostedContractDemo,
} from './hosted.js';
import { deserialize, serialize } from './serde.js';

const baseRequest = {
  jobId: 'job-1',
  repoSlug: 'on-par/software-factory',
  taskPayload: 'do the thing',
  requiredCapabilities: ['git', 'node'],
  requiredAuthority: 'repo:write',
  status: 'requested',
  createdAt: '2026-08-19T00:00:00.000Z',
};

const baseEvent = {
  jobId: 'job-1',
  type: 'requested',
  ts: '2026-08-19T00:00:00.000Z',
  severity: 'info',
  message: 'hosted job requested',
};

const baseLease = {
  runnerId: 'runner-1',
  leaseId: 'lease-1',
  jobId: 'job-1',
  expiresAt: '2026-08-19T01:00:00.000Z',
  heartbeatIntervalMs: 30_000,
};

const baseResult = {
  jobId: 'job-1',
  outcome: 'completed',
  summary: 'hosted job completed',
  finishedAt: '2026-08-19T01:00:00.000Z',
};

describe('HostedJobRequestSchema', () => {
  it('parses a fully-populated request', () => {
    expect(HostedJobRequestSchema.parse(baseRequest)).toEqual(baseRequest);
  });

  it('rejects a missing jobId', () => {
    const { jobId: _jobId, ...withoutJobId } = baseRequest;
    expect(() => HostedJobRequestSchema.parse(withoutJobId)).toThrow();
  });

  it('rejects a missing requiredCapabilities', () => {
    const { requiredCapabilities: _requiredCapabilities, ...withoutCapabilities } = baseRequest;
    expect(() => HostedJobRequestSchema.parse(withoutCapabilities)).toThrow();
  });

  it('rejects an unknown status', () => {
    expect(() => HostedJobRequestSchema.parse({ ...baseRequest, status: 'exploded' })).toThrow();
  });

  it('parses a canceled status (#903)', () => {
    const canceled = { ...baseRequest, status: 'canceled' };
    expect(HostedJobRequestSchema.parse(canceled)).toEqual(canceled);
  });
});

describe('RunnerLeaseSchema', () => {
  it('parses a full lease', () => {
    expect(RunnerLeaseSchema.parse(baseLease)).toEqual(baseLease);
  });

  it('rejects a missing heartbeatIntervalMs', () => {
    const { heartbeatIntervalMs: _heartbeatIntervalMs, ...withoutHeartbeat } = baseLease;
    expect(() => RunnerLeaseSchema.parse(withoutHeartbeat)).toThrow();
  });

  it('rejects a non-positive heartbeatIntervalMs', () => {
    expect(() => RunnerLeaseSchema.parse({ ...baseLease, heartbeatIntervalMs: 0 })).toThrow();
  });

  it('round-trips through serialize/deserialize', () => {
    const raw = serialize(RunnerLeaseSchema, baseLease);
    expect(deserialize(RunnerLeaseSchema, raw)).toEqual(baseLease);
  });
});

describe('HostedJobEventSchema', () => {
  it('parses a full event', () => {
    expect(HostedJobEventSchema.parse(baseEvent)).toEqual(baseEvent);
  });

  it('rejects a missing message', () => {
    const { message: _message, ...withoutMessage } = baseEvent;
    expect(() => HostedJobEventSchema.parse(withoutMessage)).toThrow();
  });

  it('rejects an unknown type', () => {
    expect(() => HostedJobEventSchema.parse({ ...baseEvent, type: 'unknown' })).toThrow();
  });

  it('parses a cleaned event', () => {
    expect(HostedJobEventSchema.parse({ ...baseEvent, type: 'cleaned' })).toEqual({ ...baseEvent, type: 'cleaned' });
  });

  it('parses a canceled event', () => {
    expect(HostedJobEventSchema.parse({ ...baseEvent, type: 'canceled' })).toEqual({ ...baseEvent, type: 'canceled' });
  });

  it('parses a watchdog event', () => {
    expect(HostedJobEventSchema.parse({ ...baseEvent, type: 'watchdog' })).toEqual({ ...baseEvent, type: 'watchdog' });
  });

  it('rejects an unknown severity', () => {
    expect(() => HostedJobEventSchema.parse({ ...baseEvent, severity: 'critical' })).toThrow();
  });

  it('round-trips through serialize/deserialize', () => {
    const raw = serialize(HostedJobEventSchema, baseEvent);
    expect(deserialize(HostedJobEventSchema, raw)).toEqual(baseEvent);
  });
});

describe('HostedJobResultSchema', () => {
  it('parses a full result', () => {
    expect(HostedJobResultSchema.parse(baseResult)).toEqual(baseResult);
  });

  it('rejects a missing summary', () => {
    const { summary: _summary, ...withoutSummary } = baseResult;
    expect(() => HostedJobResultSchema.parse(withoutSummary)).toThrow();
  });

  it('rejects an unknown outcome', () => {
    expect(() => HostedJobResultSchema.parse({ ...baseResult, outcome: 'exploded' })).toThrow();
  });

  it('round-trips through serialize/deserialize', () => {
    const raw = serialize(HostedJobResultSchema, baseResult);
    expect(deserialize(HostedJobResultSchema, raw)).toEqual(baseResult);
  });

  it('parses a result with exitCode, failurePhase, logsTail, and artifacts (back-compat additive)', () => {
    const richResult = {
      ...baseResult,
      outcome: 'failed',
      exitCode: 1,
      failurePhase: 'run',
      logsTail: 'last 2000 chars of logs',
      artifacts: [{ name: 'build.log', ref: '/artifacts/job-1/build.log', kind: 'log', sizeBytes: 128 }],
    };
    expect(HostedJobResultSchema.parse(richResult)).toEqual(richResult);
  });

  it('rejects an unknown failurePhase', () => {
    expect(() => HostedJobResultSchema.parse({ ...baseResult, failurePhase: 'deploy' })).toThrow();
  });

  it('parses a canceled outcome (#903)', () => {
    const canceledResult = { ...baseResult, outcome: 'canceled', summary: 'hosted job canceled: operator request' };
    expect(HostedJobResultSchema.parse(canceledResult)).toEqual(canceledResult);
  });
});

describe('HostedArtifactRefSchema', () => {
  const baseArtifact = { name: 'build.log', ref: '/artifacts/job-1/build.log', kind: 'log' };

  it('parses a minimal artifact ref', () => {
    expect(HostedArtifactRefSchema.parse(baseArtifact)).toEqual(baseArtifact);
  });

  it('parses an artifact ref with sizeBytes and sha256', () => {
    const full = { ...baseArtifact, sizeBytes: 42, sha256: 'deadbeef' };
    expect(HostedArtifactRefSchema.parse(full)).toEqual(full);
  });

  it('rejects a missing ref', () => {
    const { ref: _ref, ...withoutRef } = baseArtifact;
    expect(() => HostedArtifactRefSchema.parse(withoutRef)).toThrow();
  });

  it('rejects a negative sizeBytes', () => {
    expect(() => HostedArtifactRefSchema.parse({ ...baseArtifact, sizeBytes: -1 })).toThrow();
  });
});

describe('ProviderSessionBundleSchema', () => {
  const baseBundle = {
    provider: 'codex-oauth',
    jobId: 'job-1',
    mountPath: '/root/.codex',
    secrets: [{ name: 'oauth_token', handle: 'handle-1' }],
  };

  it.each(['codex-oauth', 'claude-code-oauth', 'opencode-go-oauth', 'pi-dev'] as const)(
    'parses a fully-populated bundle for provider %s',
    (provider) => {
      const bundle = { ...baseBundle, provider };
      expect(ProviderSessionBundleSchema.parse(bundle)).toEqual(bundle);
    },
  );

  it('rejects an unknown provider kind', () => {
    expect(() => ProviderSessionBundleSchema.parse({ ...baseBundle, provider: 'nope' })).toThrow();
  });

  it('rejects an empty secrets array', () => {
    expect(() => ProviderSessionBundleSchema.parse({ ...baseBundle, secrets: [] })).toThrow();
  });

  it('rejects a secret ref missing handle', () => {
    expect(() => ProviderSessionBundleSchema.parse({ ...baseBundle, secrets: [{ name: 'oauth_token' }] })).toThrow();
  });

  it('round-trips through serialize/deserialize', () => {
    const raw = serialize(ProviderSessionBundleSchema, baseBundle);
    expect(deserialize(ProviderSessionBundleSchema, raw)).toEqual(baseBundle);
  });
});

describe('hostedExecEnabled', () => {
  it('returns false for an empty env', () => {
    expect(hostedExecEnabled({})).toBe(false);
  });

  it("returns false for FACTORY_HOSTED_EXEC='0'", () => {
    expect(hostedExecEnabled({ [HOSTED_EXEC_FLAG]: '0' })).toBe(false);
  });

  it("returns false for FACTORY_HOSTED_EXEC='true'", () => {
    expect(hostedExecEnabled({ [HOSTED_EXEC_FLAG]: 'true' })).toBe(false);
  });

  it("returns true only for FACTORY_HOSTED_EXEC='1'", () => {
    expect(hostedExecEnabled({ [HOSTED_EXEC_FLAG]: '1' })).toBe(true);
  });
});

describe('runHostedContractDemo', () => {
  it('constructs nothing when disabled', () => {
    const result = runHostedContractDemo({});
    expect(result.enabled).toBe(false);
    expect(result.request).toBeUndefined();
    expect(result.event).toBeUndefined();
    expect(result.lease).toBeUndefined();
    expect(result.trace).toBe('hosted execution disabled — local path unchanged');
  });

  it('returns the full trace when enabled', () => {
    const result = runHostedContractDemo({ [HOSTED_EXEC_FLAG]: '1' });
    expect(result.enabled).toBe(true);
    expect(result.trace).toBe('job requested -> event emitted -> runner leaseable');
    expect(result.request).toBeDefined();
    expect(result.event).toBeDefined();
    expect(result.lease).toBeDefined();
    expect(result.request?.jobId).toBe(result.event?.jobId);
    expect(result.event?.jobId).toBe(result.lease?.jobId);
  });
});
