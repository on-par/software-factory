import { describe, expect, it } from 'vitest';

import { loadModelsConfig } from '../config/index.js';
import { type ModelDiagnosis, ModelRegistry, diagnoseModels } from './index.js';
import { applyZdrReview, zdrReviewReason } from './zdr-review.js';

const GO = 'opencode-go/deepseek-v4-flash';
const AFTER = new Date('2026-11-01T00:00:00Z');

const row = (over: Partial<ModelDiagnosis> = {}): ModelDiagnosis => ({
  model: 'm',
  provider: 'p',
  tiers: [],
  reachable: true,
  experimental: false,
  reason: 'ok (opencode CLI)',
  ...over,
});

describe('zdrReviewReason', () => {
  it('flags OpenCode Go after its review date', () => {
    const reason = zdrReviewReason(GO, AFTER);
    expect(reason).toContain('ZDR review date 2026-10-31 passed for OpenCode Go');
    expect(reason).toContain('ADR-0163');
  });

  it('is null on the review day and before it', () => {
    expect(zdrReviewReason(GO, new Date('2026-10-31T23:00:00Z'))).toBeNull();
    expect(zdrReviewReason(GO, new Date('2026-10-14T00:00:00Z'))).toBeNull();
  });

  it('is null for intermediaries without reviewBy and for non-intermediary models', () => {
    expect(zdrReviewReason('openrouter/deepseek/deepseek-chat', new Date('2027-01-01T00:00:00Z'))).toBeNull();
    expect(zdrReviewReason('claude-sonnet-5', AFTER)).toBeNull();
  });
});

describe('applyZdrReview', () => {
  const now = () => AFTER;

  it('turns a reachable row into unverified and keeps the old reason', () => {
    const out = applyZdrReview(row(), GO, now);
    expect(out).toMatchObject({ reachable: false, unverified: true });
    expect(out.reason).toContain('ZDR review date 2026-10-31 passed');
    expect(out.reason).toContain('(ok (opencode CLI))');
  });

  it('keeps an unverified row unverified with the reason prefixed', () => {
    const out = applyZdrReview(row({ reachable: false, unverified: true, reason: 'no login' }), GO, now);
    expect(out.unverified).toBe(true);
    expect(out.reason).toMatch(/^ZDR review date .*\(no login\)$/);
  });

  it('keeps a hard failure failed and appends the note', () => {
    const out = applyZdrReview(row({ reachable: false, reason: 'opencode CLI not found on PATH' }), GO, now);
    expect(out.reachable).toBe(false);
    expect(out.unverified).toBeFalsy();
    expect(out.reason).toMatch(/^opencode CLI not found on PATH; ZDR review date 2026-10-31 passed/);
  });

  it('leaves excluded rows unchanged', () => {
    const exp = row({ reachable: false, reason: 'experimental — set FACTORY_EXPERIMENTAL=1 to enable' });
    const local = row({ reachable: false, reason: 'excluded by FACTORY_LOCAL_ONLY=1' });
    expect(applyZdrReview(exp, GO, now)).toBe(exp);
    expect(applyZdrReview(local, GO, now)).toBe(local);
  });

  it('uses the real clock by default', () => {
    const out = applyZdrReview(row(), 'claude-sonnet-5');
    expect(out.reachable).toBe(true);
  });
});

describe('diagnoseModels ZDR review', () => {
  const registry = new ModelRegistry(loadModelsConfig());
  const probes = {
    commandAvailable: () => true,
    envPresent: () => true,
    opencodeLoggedIn: () => true,
    claudeLoggedIn: () => true,
    codexLoggedIn: () => true,
    localAuthFailure: () => null,
    harnessProbe: () => null,
  };
  const find = (now: string, id: string) =>
    diagnoseModels(registry, { ...probes, now: () => new Date(now) }, true).find((d) => d.model === id)!;

  it('flags opencode-deepseek-v4-flash as unverified once its ZDR review date has passed', () => {
    const d = find('2026-11-01T00:00:00Z', 'opencode-deepseek-v4-flash');
    expect(d.unverified).toBe(true);
    expect(d.reason).toContain('ZDR review date 2026-10-31 passed');
  });

  it('leaves opencode-deepseek-v4-flash unchanged before its ZDR review date', () => {
    const d = find('2026-10-14T12:00:00Z', 'opencode-deepseek-v4-flash');
    expect(d.reason).not.toContain('ZDR review date');
    expect(d.reachable).toBe(true);
  });

  it('leaves a model with no intermediary unchanged after the date', () => {
    expect(registry.list()).toContain('claude-sonnet-5');
    expect(find('2026-11-01T00:00:00Z', 'claude-sonnet-5').reason).not.toContain('ZDR review date');
  });
});
