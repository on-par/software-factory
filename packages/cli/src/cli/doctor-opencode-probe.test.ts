// packages/cli/src/cli/doctor-opencode-probe.test.ts — live OpenCode auth probe rows (#2892)

import { loadModelsConfig } from '@on-par/factory-core';
import { shellEscape } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';

import { reconcileAgentAuthChecks } from './doctor.js';
import {
  opencodeAuthProbeCommand,
  opencodeLiveAuthCheck,
  pinnedOpencodeProviderModel,
} from './doctor-opencode-probe.js';

describe('opencodeLiveAuthCheck (#2892)', () => {
  const ran = (stdout: string, exitCode = 1, stderr = '') => ({ kind: 'ran' as const, exitCode, stdout, stderr });
  const err = (error: Record<string, unknown>) => JSON.stringify({ type: 'error', error });

  it('is a skipped optional pass when opencode is not on PATH', () => {
    const c = opencodeLiveAuthCheck({ kind: 'skipped' });
    expect(c).toMatchObject({ name: 'opencode auth (live)', ok: true, optional: true });
    expect(c.detail).toContain('not on PATH');
  });

  it('passes on a text event', () => {
    const c = opencodeLiveAuthCheck(ran(JSON.stringify({ type: 'text', part: { text: 'ok' } }), 0));
    expect(c.ok).toBe(true);
  });

  it('fails with the login fix on a 401 error event', () => {
    const c = opencodeLiveAuthCheck(ran(err({ name: 'APIError', data: { message: 'Unauthorized', statusCode: 401 } })));
    expect(c.ok).toBe(false);
    expect(c.fix).toBe('opencode auth login');
  });

  it('fails with the login fix on a provider.auth error type', () => {
    const c = opencodeLiveAuthCheck(ran(err({ type: 'provider.auth' })));
    expect(c.fix).toBe('opencode auth login');
  });

  it('warns on a rate limit', () => {
    const c = opencodeLiveAuthCheck(ran(err({ type: 'provider.rate-limit', status: 429 })));
    expect(c).toMatchObject({ ok: false, optional: true });
    expect(c.detail).toContain('rate limit');
  });

  it('warns on a usage cap', () => {
    const c = opencodeLiveAuthCheck(ran(err({ type: 'provider.quota' })));
    expect(c).toMatchObject({ ok: false, optional: true });
    expect(c.detail).toContain('usage cap');
  });

  it('fails with timed out on a timeout', () => {
    const c = opencodeLiveAuthCheck({ kind: 'timeout' });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('timed out');
  });

  it('fails with a non-auth fix on empty output', () => {
    const c = opencodeLiveAuthCheck(ran(''));
    expect(c.ok).toBe(false);
    expect(c.fix).not.toBe('opencode auth login');
    expect(c.detail).toContain('no text in opencode run output (exit 1)');
  });
});

describe('opencodeAuthProbeCommand (#2892)', () => {
  it('has no --model without a provider model', () => {
    expect(opencodeAuthProbeCommand()).toBe('opencode run --format json "reply with exactly: ok"');
  });

  it('passes the shell-escaped provider model', () => {
    expect(opencodeAuthProbeCommand('opencode-go/x')).toContain(`--model ${shellEscape('opencode-go/x')}`);
  });
});

describe('pinnedOpencodeProviderModel (#2892)', () => {
  const models = loadModelsConfig();
  const repo = (build: string) => ({ models: { pins: { build } } }) as never;

  it('returns the provider model of an opencode pin', () => {
    expect(pinnedOpencodeProviderModel(models, repo('opencode-deepseek-v4-flash'))).toBe(
      'opencode-go/deepseek-v4.1-flash',
    );
  });

  it('ignores a pin on another harness', () => {
    expect(pinnedOpencodeProviderModel(models, repo('claude-sonnet-4-6'))).toBeUndefined();
  });

  it('returns undefined without a repo config', () => {
    expect(pinnedOpencodeProviderModel(models, null as never)).toBeUndefined();
  });
});

describe('reconcileAgentAuthChecks with opencode auth (live) (#2892)', () => {
  it('downgrades a failed live row when another agent is signed in', () => {
    const rows = reconcileAgentAuthChecks([
      { name: 'claude signed in', ok: true, detail: 'ok' },
      { name: 'opencode auth (live)', ok: false, detail: 'rejected' },
    ]);
    expect(rows.find((r) => r.name === 'opencode auth (live)')?.optional).toBe(true);
  });
});
