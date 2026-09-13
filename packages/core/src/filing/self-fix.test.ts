import { describe, expect, it } from 'vitest';

import type { EvidencePack, FingerprintedFailure } from '../types/index.js';
import { DEFAULT_INTERNAL_REPO, fingerprintMarker, type CandidateIssue, type FilingGitHubClient } from './index.js';
import { DEFAULT_FILING_POLICY } from './policy.js';
import { requestSelfFix, selfFixLabels } from './self-fix.js';

const clock = () => new Date('2026-09-12T00:00:00.000Z');

function makeEvidence(overrides: Partial<EvidencePack> = {}): EvidencePack {
  return {
    repo: 'on-par/widgets',
    issue: '42',
    phase: 'build',
    model: 'claude-sonnet-5',
    reason: 'verify_failed',
    component: 'check:tests',
    origin: 'product',
    eventExcerpt: 'tests failed: 2 of 40',
    logPath: '/logs/run-1.ndjson',
    ...overrides,
  };
}

function makeFingerprinted(
  overrides: Partial<EvidencePack> = {},
  fingerprint = 'ff_0123456789abcdef',
): FingerprintedFailure {
  return { fingerprint, evidence: makeEvidence(overrides) };
}

function makeFakeClient(seedIssues: CandidateIssue[], appendCreated = false) {
  const created: any[] = [];
  const updated: any[] = [];
  const commented: any[] = [];
  const labelled: any[] = [];
  let nextNumber = 1000;
  const client: FilingGitHubClient = {
    async listCandidateIssues() {
      return seedIssues;
    },
    async createIssue(input) {
      created.push(input);
      const number = nextNumber++;
      if (appendCreated) seedIssues.push({ number, body: input.body, labels: input.labels });
      return { number };
    },
    async updateIssue(input) {
      updated.push(input);
      const issue = seedIssues.find((candidate) => candidate.number === input.issue_number);
      if (issue) issue.body = input.body;
    },
    async addLabels(input) {
      labelled.push(input);
    },
    async commentIssue(input) {
      commented.push(input);
    },
  };
  return { client, created, updated, commented, labelled };
}

describe('selfFixLabels', () => {
  it('combines default bug and guard labels, deduping a repeated guard label', () => {
    expect(selfFixLabels(DEFAULT_FILING_POLICY)).toEqual(['bug', 'no-auto-merge']);
    expect(selfFixLabels({ ...DEFAULT_FILING_POLICY, bugLabels: ['bug', 'no-auto-merge'] })).toEqual([
      'bug',
      'no-auto-merge',
    ]);
    expect(selfFixLabels({ ...DEFAULT_FILING_POLICY, selfFixLabel: 'needs-human-merge' })).toEqual([
      'bug',
      'needs-human-merge',
    ]);
  });
});

describe('requestSelfFix', () => {
  it('Scenario 1 — files one guard-labelled issue for a new fingerprint', async () => {
    const fingerprinted = makeFingerprinted({ origin: 'factory-internal' });
    const { client, created, labelled } = makeFakeClient([]);

    const result = await requestSelfFix(client, { fingerprinted, policy: DEFAULT_FILING_POLICY, now: clock });

    expect(created).toHaveLength(1);
    expect(created[0].labels).toEqual(['bug', 'no-auto-merge']);
    expect(created[0].body).toContain(fingerprintMarker(fingerprinted.fingerprint));
    expect(labelled).toHaveLength(0);
    expect(result).toMatchObject({
      action: 'created',
      occurrences: 1,
      repo: DEFAULT_INTERNAL_REPO,
      labels: ['bug', 'no-auto-merge'],
    });
  });

  it('Scenario 2 — reuses the matching issue and restores its guard label', async () => {
    const fingerprinted = makeFingerprinted({ origin: 'factory-internal' });
    const { client, created, updated, commented, labelled } = makeFakeClient([
      { number: 7, body: `${fingerprintMarker(fingerprinted.fingerprint)}\n<!-- fp-count:1 -->`, labels: ['bug'] },
    ]);

    const result = await requestSelfFix(client, { fingerprinted, policy: DEFAULT_FILING_POLICY, now: clock });

    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0].body).toContain('<!-- fp-count:2 -->');
    expect(commented).toHaveLength(1);
    expect(labelled).toEqual([
      { owner: 'on-par', repo: 'software-factory', issue_number: 7, labels: ['bug', 'no-auto-merge'] },
    ]);
    expect(result).toMatchObject({ action: 'bumped', issueNumber: 7, occurrences: 2 });
  });

  it('creates exactly one issue across repeated requests', async () => {
    const fingerprinted = makeFingerprinted({ origin: 'factory-internal' });
    const { client, created } = makeFakeClient([], true);

    await requestSelfFix(client, { fingerprinted, policy: DEFAULT_FILING_POLICY, now: clock });
    await requestSelfFix(client, { fingerprinted, policy: DEFAULT_FILING_POLICY, now: clock });
    const result = await requestSelfFix(client, { fingerprinted, policy: DEFAULT_FILING_POLICY, now: clock });

    expect(created).toHaveLength(1);
    expect(result).toMatchObject({ action: 'bumped', occurrences: 3 });
  });

  it('bypasses automatic filing suppression for an explicit request', async () => {
    const { client, created } = makeFakeClient([]);
    await requestSelfFix(client, {
      fingerprinted: makeFingerprinted({ origin: 'factory-internal', reason: 'verify_failed' }),
      policy: {
        ...DEFAULT_FILING_POLICY,
        enabled: false,
        maxPerRun: 0,
        maxPerDay: 0,
        excludeReasons: ['verify_failed'],
      },
      now: clock,
    });
    expect(created).toHaveLength(1);
  });

  it('uses a custom guard label on create and bump', async () => {
    const policy = { ...DEFAULT_FILING_POLICY, selfFixLabel: 'needs-human-merge', bugLabels: ['defect'] };
    const fingerprinted = makeFingerprinted({ origin: 'factory-internal' });
    const { client, created, labelled } = makeFakeClient([], true);

    await requestSelfFix(client, { fingerprinted, policy, now: clock });
    await requestSelfFix(client, { fingerprinted, policy, now: clock });

    expect(created[0].labels).toEqual(['defect', 'needs-human-merge']);
    expect(labelled[0].labels).toEqual(['defect', 'needs-human-merge']);
  });
});
