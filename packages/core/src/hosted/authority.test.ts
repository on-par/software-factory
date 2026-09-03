import type { ProviderKind, ProviderSessionBundle } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import {
  AUTHORITY_REDACTION_MASK,
  redactSecrets,
  withAuthority,
  type AuthorityBroker,
  type AuthorityCleanupProof,
  type AuthorityMount,
  type AuthorityMountEngine,
  type PrepareAuthorityConfig,
  type ResolvedSecret,
} from './authority.js';

function baseBundle(overrides: Partial<ProviderSessionBundle> = {}): ProviderSessionBundle {
  return {
    provider: 'claude-code-oauth',
    jobId: 'job-1',
    mountPath: '/root/.claude',
    secrets: [{ name: 'oauth_token', handle: 'handle-1' }],
    ...overrides,
  };
}

function baseConfig(overrides: Partial<PrepareAuthorityConfig> = {}): PrepareAuthorityConfig {
  return {
    jobId: 'job-1',
    supported: new Set<ProviderKind>(['claude-code-oauth', 'codex-oauth', 'opencode-go-oauth', 'pi-dev']),
    ...overrides,
  };
}

interface FakeBrokerScript {
  secrets?: ResolvedSecret[];
  error?: Error;
}

function createFakeBroker(script: FakeBrokerScript, calls: { resolveCount: number }): AuthorityBroker {
  return {
    async resolve() {
      calls.resolveCount += 1;
      if (script.error) throw script.error;
      return script.secrets ?? [{ name: 'oauth_token', value: 'super-secret-value' }];
    },
  };
}

interface FakeEngineCalls {
  mountCount: number;
  unmountCount: number;
  unmounted: AuthorityMount[];
}

function createFakeEngine(calls: FakeEngineCalls): AuthorityMountEngine {
  return {
    async mount(bundle, _secrets): Promise<AuthorityMount> {
      calls.mountCount += 1;
      return {
        provider: bundle.provider,
        jobId: bundle.jobId,
        hostPath: `/tmp/sf-auth-${bundle.jobId}`,
        mountPath: bundle.mountPath,
      };
    },
    async unmount(mount): Promise<AuthorityCleanupProof> {
      calls.unmountCount += 1;
      calls.unmounted.push(mount);
      return { hostPath: mount.hostPath, removed: true, evidence: `unmounted ${mount.hostPath}` };
    },
  };
}

describe('redactSecrets', () => {
  it('masks multiple occurrences of a secret value', () => {
    const secrets: ResolvedSecret[] = [{ name: 'oauth_token', value: 'super-secret-value' }];
    const text = 'token=super-secret-value; retry with super-secret-value';
    const result = redactSecrets(text, secrets);
    expect(result).toBe(`token=${AUTHORITY_REDACTION_MASK}; retry with ${AUTHORITY_REDACTION_MASK}`);
    expect(result).not.toContain('super-secret-value');
  });

  it('skips empty-value secrets and leaves the text unchanged', () => {
    const secrets: ResolvedSecret[] = [{ name: 'empty', value: '' }];
    expect(redactSecrets('nothing to mask here', secrets)).toBe('nothing to mask here');
  });
});

describe('withAuthority', () => {
  it('AC#1/AC#2 Claude smoke: runs use, redacts raw secret out of a log line, and leaks nothing into the outcome', async () => {
    const brokerCalls = { resolveCount: 0 };
    const broker = createFakeBroker({ secrets: [{ name: 'oauth_token', value: 'super-secret-value' }] }, brokerCalls);
    const engineCalls: FakeEngineCalls = { mountCount: 0, unmountCount: 0, unmounted: [] };
    const engine = createFakeEngine(engineCalls);
    const bundle = baseBundle({ provider: 'claude-code-oauth' });

    const outcome = await withAuthority(broker, engine, bundle, baseConfig(), async (mount, redact) => {
      const logLine = `mounted claude session with token=super-secret-value at ${mount.hostPath}`;
      return redact(logLine);
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.used).toBe(true);
    expect(outcome.value).toContain(AUTHORITY_REDACTION_MASK);
    expect(outcome.value).not.toContain('super-secret-value');
    expect(JSON.stringify(outcome)).not.toContain('super-secret-value');
    expect(outcome.cleanup).toBeDefined();
    expect(engineCalls.mountCount).toBe(1);
    expect(engineCalls.unmountCount).toBe(1);
  });

  it('AC#3 absent: fails closed without mounting when bundle is undefined', async () => {
    const brokerCalls = { resolveCount: 0 };
    const broker = createFakeBroker({}, brokerCalls);
    const engineCalls: FakeEngineCalls = { mountCount: 0, unmountCount: 0, unmounted: [] };
    const engine = createFakeEngine(engineCalls);

    const outcome = await withAuthority(broker, engine, undefined, baseConfig(), async () => 'never');

    expect(outcome.ok).toBe(false);
    expect(outcome.used).toBe(false);
    expect(outcome.failure).toEqual({ reason: 'absent', detail: 'no provider authority bundle supplied' });
    expect(engineCalls.mountCount).toBe(0);
  });

  it('AC#3 invalid: fails closed without mounting on a malformed bundle', async () => {
    const brokerCalls = { resolveCount: 0 };
    const broker = createFakeBroker({}, brokerCalls);
    const engineCalls: FakeEngineCalls = { mountCount: 0, unmountCount: 0, unmounted: [] };
    const engine = createFakeEngine(engineCalls);

    const outcome = await withAuthority(broker, engine, { provider: 'nope' }, baseConfig(), async () => 'never');

    expect(outcome.ok).toBe(false);
    expect(outcome.used).toBe(false);
    expect(outcome.failure?.reason).toBe('invalid');
    expect(engineCalls.mountCount).toBe(0);
  });

  it('AC#3 unsupported: fails closed without mounting or resolving when provider is outside the runner set', async () => {
    const brokerCalls = { resolveCount: 0 };
    const broker = createFakeBroker({}, brokerCalls);
    const engineCalls: FakeEngineCalls = { mountCount: 0, unmountCount: 0, unmounted: [] };
    const engine = createFakeEngine(engineCalls);
    const bundle = baseBundle({ provider: 'pi-dev' });
    const config = baseConfig({ supported: new Set<ProviderKind>(['claude-code-oauth']) });

    const outcome = await withAuthority(broker, engine, bundle, config, async () => 'never');

    expect(outcome.ok).toBe(false);
    expect(outcome.used).toBe(false);
    expect(outcome.failure).toEqual({ reason: 'unsupported', detail: 'provider pi-dev not supported by runner' });
    expect(brokerCalls.resolveCount).toBe(0);
    expect(engineCalls.mountCount).toBe(0);
  });

  it('AC#3 resolve-failed: fails closed without mounting when the broker cannot resolve', async () => {
    const brokerCalls = { resolveCount: 0 };
    const broker = createFakeBroker({ error: new Error('handle expired') }, brokerCalls);
    const engineCalls: FakeEngineCalls = { mountCount: 0, unmountCount: 0, unmounted: [] };
    const engine = createFakeEngine(engineCalls);

    const outcome = await withAuthority(broker, engine, baseBundle(), baseConfig(), async () => 'never');

    expect(outcome.ok).toBe(false);
    expect(outcome.used).toBe(false);
    expect(outcome.failure).toEqual({ reason: 'resolve-failed', detail: 'handle expired' });
    expect(engineCalls.mountCount).toBe(0);
  });

  it('AC#4 cleanup always: unmounts exactly once even when use() throws, and the error still propagates', async () => {
    const brokerCalls = { resolveCount: 0 };
    const broker = createFakeBroker({}, brokerCalls);
    const engineCalls: FakeEngineCalls = { mountCount: 0, unmountCount: 0, unmounted: [] };
    const engine = createFakeEngine(engineCalls);

    await expect(
      withAuthority(broker, engine, baseBundle(), baseConfig(), async () => {
        throw new Error('use exploded');
      }),
    ).rejects.toThrow('use exploded');

    expect(engineCalls.mountCount).toBe(1);
    expect(engineCalls.unmountCount).toBe(1);
  });

  it('AC#4 cleanup on success: unmounts exactly once and returns the cleanup proof', async () => {
    const brokerCalls = { resolveCount: 0 };
    const broker = createFakeBroker({}, brokerCalls);
    const engineCalls: FakeEngineCalls = { mountCount: 0, unmountCount: 0, unmounted: [] };
    const engine = createFakeEngine(engineCalls);

    const outcome = await withAuthority(broker, engine, baseBundle(), baseConfig(), async (mount) => mount.hostPath);

    expect(outcome.ok).toBe(true);
    expect(outcome.cleanup?.removed).toBe(true);
    expect(engineCalls.unmountCount).toBe(1);
    expect(outcome.trace).toBe('authority claude-code-oauth mounted -> used -> cleaned');
  });
});
