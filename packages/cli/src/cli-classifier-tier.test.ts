import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './cli/index.js';

const tmp = createTempDirs();
let repo: string;
let cwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  cwd = process.cwd();
  repo = realpathSync(tmp.makeSync('cli-classifier-tier-'));
  execSync('git init -q', { cwd: repo });
  mkdirSync(join(repo, '.factory', 'state'), { recursive: true });
  process.chdir(repo);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(async () => {
  process.chdir(cwd);
  await tmp.cleanup();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const logged = () => logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
const runMain = (...args: string[]) => main(['node', 'factory', ...args]);
const outcomesFile = () => join(repo, '.factory', 'state', 'classifier-outcomes.jsonl');

const outRec = (prNumber: number) => ({
  issue: String(prNumber),
  prNumber,
  classifiedAt: '2026-09-01T00:00:00.000Z',
  modelClass: 'A',
  floorClass: 'A',
  finalClass: 'A',
  model: 'm',
  promptVersion: 'p1',
  policyVersion: 'v1',
  diffSha: null,
  humanApproved: false,
  humanEdited: false,
  humanAbandoned: false,
  merged: true,
  mergedAt: '2026-08-01T00:00:00.000Z',
  defectWindowClosed: true,
  defectFired: false,
  verdict: 'agree',
  slipped: false,
});

const seed = () => {
  const recs = Array.from({ length: 60 }, (_, i) => outRec(i + 1));
  writeFileSync(outcomesFile(), `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
};

const writeEvidence = () => {
  const measuredAt = new Date().toISOString();
  writeFileSync(
    join(repo, 'mutation-summary.json'),
    JSON.stringify({ packages: [{ package: 'core', score: 80, floor: 70, measuredAt }] }),
  );
  writeFileSync(join(repo, 'coverage-ratchet.json'), JSON.stringify({ ok: true, measuredAt }));
};

describe('classifier report trust tier evidence (#1957)', () => {
  it('a missing file shows unknown mutation and no eligibility', async () => {
    await runMain('classifier', 'report');
    expect(logged()).toContain('mutation: unknown');
    expect(logged()).toContain('eligible for: none');
  });

  it('prints the trust tier evidence section', async () => {
    seed();
    writeEvidence();
    await runMain('classifier', 'report');
    const out = logged();
    expect(out).toContain('Trust tier evidence');
    expect(out).toContain('configured tier: T0');
    expect(out).toContain('coverage ratchet: green');
    expect(out).toContain('caveat:');
    expect(out).toContain('eligible for:');
  });

  it('--json carries the tier evidence object', async () => {
    seed();
    writeEvidence();
    await runMain('classifier', 'report', '--json');
    const report = JSON.parse(logged().trim());
    expect(report.tier.configuredTier).toBe('T0');
    expect(report.tier.mutation.status).toBeDefined();
    expect(report.tier.slips.n).toBe(60);
    expect(report.classes).toBeDefined();
  });

  it('tier evidence leaves config and state files untouched', async () => {
    seed();
    const configFile = join(repo, '.factory', 'config.yaml');
    const files = [outcomesFile(), ...(existsSync(configFile) ? [configFile] : [])];
    const before = files.map((f) => readFileSync(f));
    await runMain('classifier', 'report');
    expect(files.map((f) => readFileSync(f))).toEqual(before);
    expect(existsSync(join(repo, 'coverage-ratchet.json'))).toBe(false);
    expect(existsSync(join(repo, 'mutation-summary.json'))).toBe(false);
  });
});
