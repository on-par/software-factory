// src/adr/similarity.test.ts — normalized ADR-title duplicate matching tests (#1439).
import { describe, expect, it } from 'vitest';

import {
  ADR_TITLE_DUPLICATE_THRESHOLD,
  adrTitleSimilarity,
  findDuplicateAdrTitle,
  normalizeAdrTitle,
} from './similarity.js';

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

describe('findDuplicateAdrTitle', () => {
  const existing = [
    { title: cloudProvisioningTitle, path: 'docs/adr/0026-autonomous-cloud-provisioning.md' },
    { title: issueDispositionTitle, path: 'docs/adr/0074-issue-disposition.md' },
    {
      title: 'The CI merge gate fails closed on any conclusion outside the passing allow-list',
      path: 'docs/adr/0014-ci-merge-gate.md',
    },
  ];

  it('finds the cloud-provisioning title when the candidate omits gate', () => {
    const duplicate = findDuplicateAdrTitle('Autonomous cloud provisioning requires a human-approved plan', existing);

    expect(duplicate).toMatchObject({ title: cloudProvisioningTitle, path: existing[0]?.path });
    expect(duplicate?.similarity).toBeGreaterThanOrEqual(ADR_TITLE_DUPLICATE_THRESHOLD);
  });

  it('returns no match for distinct Worktree-GC and CI-merge-gate titles', () => {
    expect(findDuplicateAdrTitle('Worktree GC uses only local git state', existing)).toBeUndefined();
    expect(findDuplicateAdrTitle('The CI merge gate merges any green pull request', existing)).toBeUndefined();
  });
});
