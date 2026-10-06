// src/adr/similarity.test.ts — normalized ADR-title duplicate matching tests (#1439).
import { describe, expect, it } from 'vitest';

import { adrTitleSimilarity, normalizeAdrTitle } from './similarity.js';

const hostedExecutionTitle =
  'Hosted execution runs on a VPS + Docker host with stock-Docker sandboxing and per-run GitHub App installation tokens';
const cloudProvisioningTitle = 'Autonomous cloud provisioning requires a human-approved plan gate';
const issueDispositionTitle =
  'Issue disposition (closed or factory:parked) outranks an open PR in worktree GC; branch deletion still requires remote evidence';
const workspaceDiffBaseTitle = 'The workspace diff base is the run-start HEAD, captured once, authoritative for CHECK';

describe('normalizeAdrTitle', () => {
  it('lowercases, collapses punctuation, and removes only a leading article', () => {
    expect(normalizeAdrTitle('A SHIP push whose success the PR depends on is verified, never best-effort')).toBe(
      'ship push whose success the pr depends on is verified never best effort',
    );
  });
});

describe('adrTitleSimilarity', () => {
  it.each([
    ['0023/0024', hostedExecutionTitle, hostedExecutionTitle],
    ['0025/0026', cloudProvisioningTitle, cloudProvisioningTitle],
    ['0073/0074', issueDispositionTitle, issueDispositionTitle],
    ['0079/0080', workspaceDiffBaseTitle, workspaceDiffBaseTitle],
  ])('scores identical ADR-index titles for %s as 1', (_pair, first, second) => {
    expect(adrTitleSimilarity(first, second)).toBe(1);
  });

  it('accepts the duplicated 0073/0074 title after normalization', () => {
    expect(
      adrTitleSimilarity(
        'Issue disposition closed or factory parked outranks an open PR in worktree GC branch deletion still requires remote evidence',
        issueDispositionTitle,
      ),
    ).toBe(1);
  });

  it('returns 0 for an empty title on either side', () => {
    expect(adrTitleSimilarity('', cloudProvisioningTitle)).toBe(0);
    expect(adrTitleSimilarity(cloudProvisioningTitle, '')).toBe(0);
  });
});
