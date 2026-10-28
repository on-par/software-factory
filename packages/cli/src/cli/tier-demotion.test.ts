import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import type { FactoryEvent } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliExitError } from './errors.js';
import {
  cmdClassifierAckDemotion,
  recordKpiTierDemotions,
  recordTierDemotions,
  resolveEffectiveTrustTier,
  runAckTierDemotion,
} from './tier-demotion.js';

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());

const NOW = '2026-01-10T00:00:00.000Z';
const events: FactoryEvent[] = [
  {
    ts: '2026-01-01T00:00:00.000Z',
    type: 'land',
    issue: '7',
    msg: 'risk low (rules: none), trust tier T2 — eligible for auto-merge',
  },
  { ts: '2026-01-05T00:00:00.000Z', type: 'post-merge-defect', issue: '7', msg: 'issue #900 back-references PR #42' },
];

function setup() {
  const dir = tmp.makeSync('factory-tier-demotion-');
  const path = join(dir, 'state', 'tier-demotions.jsonl');
  const comment = vi.fn(async (_issue: number, _body: string) => {});
  const warn = vi.fn();
  const record = () => recordTierDemotions({ path, events, now: NOW, comment, warn });
  return { dir, path, comment, warn, record };
}

const t2 = { version: 2 as const, classifier: { trustTier: 'T2' as const } };

describe('tier demotion (cli)', () => {
  it('records a tier-demoted record for a slip at T2 and the effective tier becomes T1', async () => {
    const s = setup();
    expect(resolveEffectiveTrustTier(t2, s.path)).toBe('T2');
    const fresh = await s.record();
    expect(fresh).toHaveLength(1);
    const saved = JSON.parse(readFileSync(s.path, 'utf8').trim());
    expect(saved).toMatchObject({ type: 'tier-demoted', from: 'T2', to: 'T1', prNumber: 42, defectIssue: 900 });
    expect(resolveEffectiveTrustTier(t2, s.path)).toBe('T1');
  });

  it('leaves the repo config file byte-identical when a demotion is recorded', async () => {
    const s = setup();
    const cfg = join(s.dir, '.factory', 'config.yaml');
    mkdirSync(join(s.dir, '.factory'), { recursive: true });
    writeFileSync(cfg, 'classifier:\n  trustTier: T2\n');
    const before = { bytes: readFileSync(cfg), mtime: statSync(cfg).mtimeMs };
    await s.record();
    expect(readFileSync(cfg).equals(before.bytes)).toBe(true);
    expect(statSync(cfg).mtimeMs).toBe(before.mtime);
  });

  it('comments once on the defect issue and not again on a re-run', async () => {
    const s = setup();
    await s.record();
    await s.record();
    expect(s.comment).toHaveBeenCalledTimes(1);
    expect(s.comment).toHaveBeenCalledWith(900, expect.stringContaining('<!-- factory:tier-demoted pr=42 -->'));
  });

  it('warns and does not retry when the comment fails', async () => {
    const s = setup();
    s.comment.mockRejectedValueOnce(new Error('boom'));
    await s.record();
    await s.record();
    expect(s.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(s.comment).toHaveBeenCalledTimes(1);
  });

  it('refuses to record over a malformed file and fails closed to T0', async () => {
    const s = setup();
    mkdirSync(join(s.dir, 'state'), { recursive: true });
    writeFileSync(s.path, 'garbage\n');
    expect(await s.record()).toEqual([]);
    expect(s.warn).toHaveBeenCalledWith(expect.stringContaining(s.path));
    expect(resolveEffectiveTrustTier(t2, s.path)).toBe('T0');
  });

  it('ack-demotion restores the configured tier', async () => {
    const s = setup();
    await s.record();
    const log = vi.fn();
    const acked = cmdClassifierAckDemotion({ path: s.path, configured: 'T2', now: NOW, by: 'pat', log });
    expect(acked).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('acknowledged PR #42 T2→T1');
    expect(log).toHaveBeenCalledWith('effective trust tier: T2');
    expect(resolveEffectiveTrustTier(t2, s.path)).toBe('T2');
  });

  it('ack-demotion with nothing open prints nothing to acknowledge', () => {
    const s = setup();
    const log = vi.fn();
    expect(cmdClassifierAckDemotion({ path: s.path, configured: 'T2', now: NOW, by: 'pat', log })).toEqual([]);
    expect(log).toHaveBeenCalledWith('No unacknowledged tier demotions.');
  });

  it('ack-demotion refuses a malformed file', () => {
    const s = setup();
    mkdirSync(join(s.dir, 'state'), { recursive: true });
    writeFileSync(s.path, 'garbage\n');
    const run = () => cmdClassifierAckDemotion({ path: s.path, configured: 'T2', now: NOW, by: 'pat', log: vi.fn() });
    expect(run).toThrow(CliExitError);
    expect(run).toThrow(/T0/);
  });

  it('comments on the PR issue when the slip has no defect issue', async () => {
    const s = setup();
    const revert: FactoryEvent[] = [
      events[0]!,
      { ts: events[1]!.ts, type: 'post-merge-defect', issue: '7', msg: 'revert commit abc1234 reverts PR #42' },
    ];
    await recordTierDemotions({ path: s.path, events: revert, now: NOW, comment: s.comment, warn: s.warn });
    expect(s.comment).toHaveBeenCalledWith(7, expect.any(String));
  });

  it('counts an unreadable file as malformed', () => {
    const s = setup();
    mkdirSync(s.path, { recursive: true });
    expect(resolveEffectiveTrustTier(t2, s.path)).toBe('T0');
  });

  it('the kpis binding comments through octokit and prints a line per demotion', async () => {
    const s = setup();
    const createComment = vi.fn(async (_args: unknown) => ({}));
    const octokit: Octokit = { rest: { issues: { createComment } } } as never;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await recordKpiTierDemotions(s.path, events, NOW, octokit, 'o', 'r');
    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({ owner: 'o', repo: 'r', issue_number: 900 }));
    expect(err.mock.calls.join('\n')).toContain('trust tier demoted T2→T1 (PR #42)');
    err.mockRestore();
  });

  it('the kpis binding reports an unexpected failure instead of throwing', async () => {
    const s = setup();
    mkdirSync(join(s.dir, 'state', 'tier-demotions.jsonl'), { recursive: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const octokit: Octokit = {} as never;
    await recordKpiTierDemotions(s.path, events, NOW, octokit, 'o', 'r');
    expect(err.mock.calls.join('\n')).toContain('tier demotions not recorded');
    err.mockRestore();
  });

  it('runAckTierDemotion acknowledges for the repo root', async () => {
    const s = setup();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runAckTierDemotion(s.dir, null);
    expect(log).toHaveBeenCalledWith('No unacknowledged tier demotions.');
    log.mockRestore();
  });
});
