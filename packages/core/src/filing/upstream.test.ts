import { describe, expect, it } from 'vitest';

import type { EvidencePack } from '../types/index.js';
import {
  buildUpstreamReport,
  factoryStackFrames,
  UPSTREAM_TITLE_PREFIX,
  upstreamInputFromEvidence,
  upstreamReportMarker,
} from './upstream.js';

const env = { factoryVersion: '1.2.3', factoryCommit: 'abc1234', os: 'darwin 25 arm64', nodeVersion: 'v22.1.0' };
const TOKEN = `ghp_${'a1'.repeat(15)}`;

function evidence(over: Partial<EvidencePack> = {}): EvidencePack {
  return {
    repo: 'acme/private-app',
    issue: '4242',
    phase: 'build',
    model: 'claude-sonnet',
    reason: 'unknown',
    component: 'claude',
    origin: 'factory-internal',
    logPath: '/Users/alice/.factory/logs/run.log',
    eventExcerpt: [
      '✗ charges the secret customer',
      `TypeError: bad 'charges the secret customer' ${TOKEN} in acme/private-app`,
      '    at run (/Users/alice/acme/private-app/src/billing.test.ts:5:2)',
      '    at fileFn (file:///x/node_modules/@on-par/factory-core/dist/filing/index.js:12:5)',
      '    at /Users/alice/acme/private-app/src/x.ts:3:1',
    ].join('\n'),
    ...over,
  };
}

const fp = 'ff_abc123';

describe('buildUpstreamReport', () => {
  const input = upstreamInputFromEvidence(
    { fingerprint: fp, evidence: evidence() },
    { ...env, redaction: { usernames: ['alice'] } },
  );
  const { title, body } = buildUpstreamReport(input);

  it('contains no target content', () => {
    const all = `${title}\n${body}`;
    for (const bad of [
      'acme/private-app',
      'private-app',
      'acme',
      'alice',
      'billing.test.ts',
      'charges the secret',
      TOKEN,
      'logPath',
      '4242',
      'run.log',
    ]) {
      expect(all).not.toContain(bad);
    }
  });

  it('has the title prefix and a single trailing marker', () => {
    expect(title.startsWith(`${UPSTREAM_TITLE_PREFIX} `)).toBe(true);
    expect(body.endsWith(`${upstreamReportMarker(fp)}\n`)).toBe(true);
    expect(body.split('<!--')).toHaveLength(2);
  });

  it('keeps only the factory frame, package-relative', () => {
    expect(body).toContain('at fileFn (@on-par/factory-core/dist/filing/index.js:12:5)');
    expect(body).not.toContain('x.ts');
  });

  it('lists every allow-listed field', () => {
    for (const v of [
      '1.2.3',
      'abc1234',
      'build',
      'unknown',
      'claude',
      fp,
      'claude-sonnet',
      'darwin 25 arm64',
      'v22.1.0',
    ]) {
      expect(body).toContain(`| ${v} |`);
    }
  });

  it('uses the Error class and strips quoted strings', () => {
    expect(body).toContain('TypeError: bad <str>');
  });
});

describe('factoryStackFrames', () => {
  it('rewrites checkout frames and drops others', () => {
    expect(factoryStackFrames('  at /repo/packages/cli/src/cli/index.ts:9:1\n  at /other/a.ts:1:1')).toEqual([
      'at @on-par/factory-cli/src/cli/index.ts:9:1',
    ]);
  });

  it('caps at 20 frames and drops odd function names', () => {
    const line = '  at f (/r/packages/core/src/a.ts:1)';
    expect(factoryStackFrames(Array(30).fill(line).join('\n'))).toHaveLength(20);
    expect(factoryStackFrames('  at weird!name (/r/packages/core/src/a.ts:1)')).toEqual([
      'at @on-par/factory-core/src/a.ts:1',
    ]);
    expect(factoryStackFrames('  at f (/r/packages/core/src/a b.ts:1)')).toEqual([]);
  });
});

describe('upstreamInputFromEvidence / builder edge cases', () => {
  it('falls back when there is no error line and no frames', () => {
    const input = upstreamInputFromEvidence(
      {
        fingerprint: fp,
        evidence: evidence({
          eventExcerpt: 'just some log text',
          relatedIssue: { repo: 'o/other-repo', number: 1 } as never,
        }),
      },
      env,
    );
    expect(input.error).toEqual({ name: 'UnknownError', message: '(no error line found)' });
    expect(input.redaction.repoSlugs).toContain('o/other-repo');
    const { body } = buildUpstreamReport(input);
    expect(body).toContain('UnknownError: (no error line found)');
    expect(body).toContain('_No factory-package frames._');
    expect(body).not.toContain('just some log text');
  });

  it('handles invalid fingerprint, custom components and bad fields', () => {
    const input = upstreamInputFromEvidence(
      { fingerprint: 'bad fp', evidence: evidence({ component: 'custom_foo', eventExcerpt: '' }) },
      { ...env, factoryCommit: null },
    );
    expect(input.harness).toBeNull();
    const { title, body } = buildUpstreamReport({ ...input, error: { name: 'bad name', message: 'a|b\nc' } });
    expect(title).toContain('in custom: Error');
    expect(body).toContain('fp:invalid');
    expect(body).toContain('| Factory commit | unknown |');
    expect(body).toContain('| Harness | unknown |');
    expect(body).toContain('Error: a|b c');
  });

  it('truncates long titles and treats check: components as harness-less', () => {
    const input = upstreamInputFromEvidence(
      { fingerprint: fp, evidence: evidence({ component: `check:${'x'.repeat(200)}` }) },
      env,
    );
    expect(input.harness).toBeNull();
    expect(buildUpstreamReport(input).title.length).toBeLessThanOrEqual(120);
  });
});
