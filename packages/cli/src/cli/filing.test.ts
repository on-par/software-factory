import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildUpstreamReport, upstreamInputFromEvidence } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';

import { type FilingPreviewDeps, resolveFactoryCheckoutCommit, runFilingPreview } from './filing.js';

const evidence = {
  repo: 'acme/private-app',
  issue: '77',
  phase: 'build',
  model: 'claude-sonnet',
  reason: 'unknown',
  component: 'claude',
  origin: 'factory-internal',
  eventExcerpt: 'Error: boom in acme/private-app\n  at f (/r/packages/core/src/a.ts:1:2)',
  logPath: '/tmp/x.log',
} as const;

function setup(events: object[]) {
  const dir = mkdtempSync(join(tmpdir(), 'filing-'));
  const eventsFile = join(dir, 'events.jsonl');
  const runsDir = join(dir, 'runs');
  mkdirSync(runsDir);
  writeFileSync(eventsFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(
    join(runsDir, 'run-1.json'),
    JSON.stringify({
      runId: 'run-1',
      repo: 'acme/private-app',
      issue: 77,
      status: 'failed',
      submittedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }),
  );
  let out = '';
  let err = '';
  const deps: FilingPreviewDeps = {
    out: { write: (s) => (out += s) },
    err: { write: (s) => (err += s) },
    eventsFile,
    runsDir,
    factoryVersion: '1.0.0',
    factoryCommit: async () => 'deadbee',
    os: 'linux 6 x64',
    nodeVersion: 'v22.0.0',
    usernames: ['alice'],
    hostnames: ['box'],
  };
  return {
    deps,
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

const ev = {
  ts: '2026-01-01T00:00:00Z',
  type: 'park',
  issue: '77',
  repo: 'acme/private-app',
  fingerprint: 'ff_1',
  evidence,
};

describe('runFilingPreview', () => {
  it('previews by fingerprint, exactly the built report', async () => {
    const s = setup([ev]);
    expect(await runFilingPreview('ff_1', s.deps)).toBe(true);
    const input = upstreamInputFromEvidence(
      { fingerprint: 'ff_1', evidence },
      {
        factoryVersion: '1.0.0',
        factoryCommit: 'deadbee',
        os: 'linux 6 x64',
        nodeVersion: 'v22.0.0',
        redaction: { usernames: ['alice', 'acme'], hostnames: ['box'] },
      },
    );
    const { title, body } = buildUpstreamReport(input);
    expect(s.out).toBe(`${title}\n\n${body}`);
    expect(s.out.startsWith('[factory-report] ')).toBe(true);
    expect(s.out).toContain('<!-- factory-upstream-report v1 fp:ff_1 -->');
    expect(s.err).toBe('Preview only — nothing was sent.\n');
  });

  it('resolves a daemon run id and redacts its repo', async () => {
    const s = setup([{ ...ev, fingerprint: 'ff_old', issue: '5' }, ev]);
    expect(await runFilingPreview('run-1', s.deps)).toBe(true);
    expect(s.out).toContain('fp:ff_1');
    expect(s.out).not.toMatch(/private-app|acme/);
  });

  it('returns false and prints nothing for an unknown run id', async () => {
    const s = setup([ev]);
    expect(await runFilingPreview('nope', s.deps)).toBe(false);
    expect(s.out).toBe('');
    expect(s.err).toBe('No failure evidence found for run nope.\n');
  });
});

describe('resolveFactoryCheckoutCommit', () => {
  function checkout(name: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'checkout-'));
    if (name) {
      mkdirSync(join(dir, 'packages/cli'), { recursive: true });
      writeFileSync(join(dir, 'packages/cli/package.json'), JSON.stringify({ name }));
    }
    return dir;
  }
  const run = (top: string) => async (cmd: string) => (cmd.includes('--show-toplevel') ? `${top}\n` : 'cafe123\n');

  it('returns HEAD for a factory checkout', async () => {
    const top = checkout('@on-par/factory-cli');
    expect(await resolveFactoryCheckoutCommit('/x', run(top))).toBe('cafe123');
  });

  it('returns null for another repo or on error', async () => {
    expect(await resolveFactoryCheckoutCommit('/x', run(checkout('other')))).toBeNull();
    expect(await resolveFactoryCheckoutCommit('/x', run(checkout(null)))).toBeNull();
    expect(await resolveFactoryCheckoutCommit('/x', async () => '')).toBeNull();
  });
});
