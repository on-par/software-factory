import { describe, expect, it } from 'vitest';
import {
  describeDraftPrPolicy,
  resolveDraftPrPolicy,
  resolveRunMaxLanes,
  RunConfigSectionSchema,
} from './run-section.js';

describe('resolveDraftPrPolicy', () => {
  it('flag beats config, config beats default, default is off', () => {
    expect(resolveDraftPrPolicy({ run: { pr: { draft: true } } }, false)).toEqual({ draft: false, source: 'flag' });
    expect(resolveDraftPrPolicy({}, true)).toEqual({ draft: true, source: 'flag' });
    expect(resolveDraftPrPolicy({ run: { pr: { draft: true } } })).toEqual({ draft: true, source: 'repo' });
    expect(resolveDraftPrPolicy({ run: { pr: {} } })).toEqual({ draft: false, source: 'default' });
    expect(resolveDraftPrPolicy({})).toEqual({ draft: false, source: 'default' });
  });
});

describe('describeDraftPrPolicy', () => {
  it('shows on/off with the flag, repo or default source', () => {
    expect(describeDraftPrPolicy({ draft: true, source: 'flag' }, 'c.json')).toBe('Draft PR: on (flag: --draft-pr)');
    expect(describeDraftPrPolicy({ draft: false, source: 'flag' }, 'c.json')).toBe(
      'Draft PR: off (flag: --no-draft-pr)',
    );
    expect(describeDraftPrPolicy({ draft: true, source: 'repo' }, 'c.json')).toBe('Draft PR: on (c.json)');
    expect(describeDraftPrPolicy({ draft: false, source: 'default' }, 'c.json')).toBe('Draft PR: off (default)');
  });
});

describe('RunConfigSectionSchema', () => {
  it('accepts run.pr.draft and run.merge.*', () => {
    expect(RunConfigSectionSchema.parse({ pr: { draft: true }, merge: { auto: true } })).toEqual({
      pr: { draft: true },
      merge: { auto: true },
    });
  });
  it('rejects a non-boolean draft and unknown run.pr keys', () => {
    expect(RunConfigSectionSchema.safeParse({ pr: { draft: 'yes' } }).success).toBe(false);
    expect(RunConfigSectionSchema.safeParse({ pr: { other: 1 } }).success).toBe(false);
  });
  it('accepts run.branchPrefix and rejects one with no letter or digit', () => {
    expect(RunConfigSectionSchema.parse({ branchPrefix: 'acme' })).toEqual({ branchPrefix: 'acme' });
    expect(RunConfigSectionSchema.safeParse({ branchPrefix: '' }).success).toBe(false);
    expect(RunConfigSectionSchema.safeParse({ branchPrefix: '!!!' }).success).toBe(false);
    expect(RunConfigSectionSchema.safeParse({ branchPrefix: 1 }).success).toBe(false);
  });
});

describe('resolveRunMaxLanes', () => {
  it('resolveRunMaxLanes prefers the flag over run.maxLanes', () => {
    expect(resolveRunMaxLanes({ run: { maxLanes: 4 } }, 2)).toEqual({ maxLanes: 2, source: 'flag' });
  });
  it('uses run.maxLanes without a flag', () => {
    expect(resolveRunMaxLanes({ run: { maxLanes: 4 } })).toEqual({ maxLanes: 4, source: 'config' });
  });
  it('is unset without a flag or config', () => {
    expect(resolveRunMaxLanes({})).toEqual({ maxLanes: undefined, source: 'unset' });
    expect(resolveRunMaxLanes({ run: {} })).toEqual({ maxLanes: undefined, source: 'unset' });
  });
  it('the schema accepts a positive integer and rejects 0, negatives, fractions and strings', () => {
    expect(RunConfigSectionSchema.parse({ maxLanes: 4 })).toEqual({ maxLanes: 4 });
    for (const bad of [0, -2, 1.5, '4']) {
      expect(RunConfigSectionSchema.safeParse({ maxLanes: bad }).success).toBe(false);
    }
  });
});
