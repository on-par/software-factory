// src/adr/write.test.ts — the ADR writer's policy and I/O split (#482).
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AdrDraft } from '@on-par/contracts';
import { createInMemoryReader } from '@on-par/repo-context';
import { afterEach, describe, expect, it } from 'vitest';

import { specPaths } from '../spec/index.js';
import {
  adrDraftErrors,
  applyAdrWritePlan,
  MAX_ADR_DRAFTS,
  parseAdrDrafts,
  planAdrWrites,
  readAdrDrafts,
} from './write.js';

function adrFixture(number: string, title: string, status: string): string {
  return `# ADR-${number}: ${title}

- Status: ${status}
- Date: 2026-07-01

## Context

Context text.

## Decision

Decision text.

## Consequences

Consequences text.
`;
}

const README_WITH_TABLE = `# Architecture Decision Records

## Index

| Number                                       | Title                | Status   |
| --------------------------------------------- | --------------------- | -------- |
| [0001](0001-first.md)                        | First decision        | Accepted |
| [0004](0004-fourth.md)                        | Fourth decision        | Accepted |
`;

const README_WITHOUT_TABLE = `# Architecture Decision Records

No table here yet.
`;

const goodDraft: AdrDraft = {
  title: 'Record ADR drafts during PLAN',
  context: 'Decisions made during PLAN evaporate into spec prose.',
  decision: 'SHIP materializes drafts as Accepted ADRs.',
  consequences: 'Future PLAN runs can read prior decisions back.',
  status: 'proposed',
  references: [],
};

describe('adrDraftErrors', () => {
  it('returns [] for a complete draft', () => {
    expect(adrDraftErrors(goodDraft)).toEqual([]);
  });

  it('reports the rationale requirement for an empty context', () => {
    const errors = adrDraftErrors({ ...goodDraft, context: '   ' });
    expect(errors.some((e) => /'why'\) is required/.test(e))).toBe(true);
  });

  it('reports an empty title', () => {
    expect(adrDraftErrors({ ...goodDraft, title: '' })).toContain('title is required');
  });

  it('reports an empty decision', () => {
    expect(adrDraftErrors({ ...goodDraft, decision: '' })).toContain('Decision is required');
  });

  it('reports an empty consequences', () => {
    expect(adrDraftErrors({ ...goodDraft, consequences: '' })).toContain('Consequences are required');
  });

  it('reports every unmet requirement at once', () => {
    const errors = adrDraftErrors({ ...goodDraft, title: '', context: '', decision: '', consequences: '' });
    expect(errors).toHaveLength(4);
  });
});

describe('parseAdrDrafts', () => {
  it('returns empty for undefined frontmatter', () => {
    expect(parseAdrDrafts(undefined)).toEqual({ drafts: [], rejected: [] });
  });

  it('returns empty for frontmatter with no adr key', () => {
    expect(parseAdrDrafts({ route: 'claude' })).toEqual({ drafts: [], rejected: [] });
  });

  it('returns empty for adr: null (a bare YAML key)', () => {
    expect(parseAdrDrafts({ adr: null })).toEqual({ drafts: [], rejected: [] });
  });

  it('rejects a non-array adr value', () => {
    const { drafts, rejected } = parseAdrDrafts({ adr: 'nope' });
    expect(drafts).toEqual([]);
    expect(rejected).toEqual([{ title: '(untitled)', errors: ['adr: must be a list of ADR drafts'] }]);
  });

  it('splits a mixed list into drafts and rejections', () => {
    const { drafts, rejected } = parseAdrDrafts({
      adr: [goodDraft, { ...goodDraft, title: 'Bad one', context: '' }],
    });
    expect(drafts).toEqual([goodDraft]);
    expect(rejected).toEqual([
      { title: 'Bad one', errors: expect.arrayContaining([expect.stringMatching(/'why'\) is required/)]) },
    ]);
  });

  it('reports a schema-invalid entry under "(untitled)"', () => {
    const { drafts, rejected } = parseAdrDrafts({ adr: [{ ...goodDraft, title: 42 }] });
    expect(drafts).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].title).toBe('(untitled)');
  });
});

describe('specPaths().adr / readAdrDrafts', () => {
  const tempDirs = new Set<string>();
  afterEach(async () => {
    await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.clear();
  });

  it('derives <spec>.adr.json next to the spec', () => {
    expect(specPaths('/x/plans/issue-482.md').adr).toBe('/x/plans/issue-482.adr.json');
  });

  it('round-trips written JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adr-write-test-'));
    tempDirs.add(dir);
    const specPath = join(dir, 'issue-482.md');
    await writeFile(specPaths(specPath).adr, JSON.stringify([goodDraft], null, 2));

    await expect(readAdrDrafts(specPath)).resolves.toEqual([goodDraft]);
  });

  it('returns [] for a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adr-write-test-'));
    tempDirs.add(dir);
    await expect(readAdrDrafts(join(dir, 'issue-482.md'))).resolves.toEqual([]);
  });

  it('returns [] for malformed JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adr-write-test-'));
    tempDirs.add(dir);
    const specPath = join(dir, 'issue-482.md');
    await writeFile(specPaths(specPath).adr, '{ not json');

    await expect(readAdrDrafts(specPath)).resolves.toEqual([]);
  });

  it('returns [] for JSON of the wrong shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adr-write-test-'));
    tempDirs.add(dir);
    const specPath = join(dir, 'issue-482.md');
    await writeFile(specPaths(specPath).adr, JSON.stringify([{ foo: 'bar' }]));

    await expect(readAdrDrafts(specPath)).resolves.toEqual([]);
  });
});

describe('planAdrWrites', () => {
  it('mints the next number, writes Nygard sections, and upserts the index', async () => {
    const reader = createInMemoryReader({
      'docs/adr/0001-first.md': adrFixture('0001', 'First decision', 'Accepted'),
      'docs/adr/0002-second.md': adrFixture('0002', 'Second decision', 'Accepted'),
      'docs/adr/0003-third.md': adrFixture('0003', 'Third decision', 'Accepted'),
      'docs/adr/0004-fourth.md': adrFixture('0004', 'Fourth decision', 'Accepted'),
      'docs/adr/README.md': README_WITH_TABLE,
    });

    const plan = await planAdrWrites(reader, [goodDraft], {
      date: '2026-07-25',
      issueRef: { text: 'Issue #482', url: 'https://github.com/on-par/software-factory/issues/482' },
    });

    expect(plan.rejected).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.writes).toHaveLength(1);
    const write = plan.writes[0];
    expect(write.number).toBe(5);
    expect(write.promoted).toBe(false);
    expect(write.path).toBe('docs/adr/0005-record-adr-drafts-during-plan.md');
    expect(write.contents).toContain('# ADR-0005:');
    expect(write.contents).toContain('- Status: Accepted');
    expect(write.contents).toContain('- Date: 2026-07-25');
    expect(write.contents).toContain('## Context');
    expect(write.contents).toContain('## Decision');
    expect(write.contents).toContain('## Consequences');
    expect(write.contents).toContain('## References');
    expect(write.contents).toContain('[Issue #482](https://github.com/on-par/software-factory/issues/482)');
    expect(plan.index?.contents).toContain('[0005](0005-record-adr-drafts-during-plan.md)');
  });

  it('mints number 1 and reports the index as missing for an empty docs/adr', async () => {
    const reader = createInMemoryReader({ 'README.md': 'root' });

    const plan = await planAdrWrites(reader, [goodDraft], { date: '2026-07-25' });

    expect(plan.writes[0].number).toBe(1);
    expect(plan.indexSkipped).toBe('missing');
    expect(plan.index).toBeUndefined();
  });

  it('still writes the ADR and reports no-table when README.md has no index table', async () => {
    const reader = createInMemoryReader({ 'docs/adr/README.md': README_WITHOUT_TABLE });

    const plan = await planAdrWrites(reader, [goodDraft], { date: '2026-07-25' });

    expect(plan.writes).toHaveLength(1);
    expect(plan.indexSkipped).toBe('no-table');
    expect(plan.index).toBeUndefined();
  });

  it('promotes an existing Proposed ADR with the same slug in place', async () => {
    const reader = createInMemoryReader({
      'docs/adr/0003-record-adr-drafts-during-plan.md': adrFixture('0003', 'Record ADR drafts during PLAN', 'Proposed'),
    });

    const plan = await planAdrWrites(reader, [goodDraft], { date: '2026-07-25' });

    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].promoted).toBe(true);
    expect(plan.writes[0].number).toBe(3);
    expect(plan.writes[0].path).toBe('docs/adr/0003-record-adr-drafts-during-plan.md');
  });

  it('skips a draft matching an already-Accepted ADR with the same slug (idempotent re-ship)', async () => {
    const reader = createInMemoryReader({
      'docs/adr/0003-record-adr-drafts-during-plan.md': adrFixture('0003', 'Record ADR drafts during PLAN', 'Accepted'),
    });

    const plan = await planAdrWrites(reader, [goodDraft], { date: '2026-07-25' });

    expect(plan.writes).toEqual([]);
    expect(plan.skipped).toEqual([
      { title: goodDraft.title, path: 'docs/adr/0003-record-adr-drafts-during-plan.md', reason: 'already-accepted' },
    ]);
  });

  it('skips a second draft that collides on the same slug instead of silently overwriting the first', async () => {
    const reader = createInMemoryReader({
      'docs/adr/0003-record-adr-drafts-during-plan.md': adrFixture('0003', 'Record ADR drafts during PLAN', 'Proposed'),
    });

    const plan = await planAdrWrites(reader, [goodDraft, { ...goodDraft }], { date: '2026-07-25' });

    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].path).toBe('docs/adr/0003-record-adr-drafts-during-plan.md');
    expect(plan.skipped).toEqual([
      {
        title: goodDraft.title,
        path: 'docs/adr/0003-record-adr-drafts-during-plan.md',
        reason: 'duplicate-slug',
      },
    ]);
  });

  it('skips with reason unreadable when an existing same-slug file cannot be read', async () => {
    const reader = {
      readDir: async () => [
        {
          name: '0003-record-adr-drafts-during-plan.md',
          path: 'docs/adr/0003-record-adr-drafts-during-plan.md',
          type: 'file' as const,
        },
      ],
      readFile: async () => undefined,
      exists: async () => true,
    };

    const plan = await planAdrWrites(reader, [goodDraft], { date: '2026-07-25' });

    expect(plan.writes).toEqual([]);
    expect(plan.skipped).toEqual([
      { title: goodDraft.title, path: 'docs/adr/0003-record-adr-drafts-during-plan.md', reason: 'unreadable' },
    ]);
  });

  it('caps at maxDrafts, reporting the remainder as skipped with reason cap', async () => {
    const reader = createInMemoryReader({ 'README.md': 'root' });
    const drafts: AdrDraft[] = Array.from({ length: 6 }, (_, i) => ({
      ...goodDraft,
      title: `Decision number ${i}`,
    }));

    const plan = await planAdrWrites(reader, drafts, { date: '2026-07-25' });

    expect(plan.writes).toHaveLength(MAX_ADR_DRAFTS);
    expect(plan.skipped).toEqual([{ title: 'Decision number 5', path: '', reason: 'cap' }]);
  });

  it('reports invalid drafts as rejected instead of writing them', async () => {
    const reader = createInMemoryReader({ 'README.md': 'root' });
    const badDraft: AdrDraft = { ...goodDraft, context: '' };

    const plan = await planAdrWrites(reader, [badDraft], { date: '2026-07-25' });

    expect(plan.writes).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0].title).toBe(goodDraft.title);
  });

  it('detects a numbered-dot convention from existing ADRs', async () => {
    const numberedDot = `# 1. First decision

- Status: Accepted
- Date: 2026-07-01

## Context

Context text.

## Decision

Decision text.

## Consequences

Consequences text.
`;
    const reader = createInMemoryReader({ 'docs/adr/0001-first.md': numberedDot });

    const plan = await planAdrWrites(reader, [goodDraft], { date: '2026-07-25' });

    expect(plan.writes[0].contents).toMatch(/^# 2\. /);
  });
});

describe('applyAdrWritePlan', () => {
  const tempDirs = new Set<string>();
  afterEach(async () => {
    await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.clear();
  });

  it('writes every file (creating docs/adr/ when absent) and returns write-then-index paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adr-apply-test-'));
    tempDirs.add(dir);

    const plan = {
      dir: 'docs/adr',
      writes: [{ path: 'docs/adr/0005-x.md', contents: '# ADR-0005: X\n', number: 5, title: 'X', promoted: false }],
      index: { path: 'docs/adr/README.md', contents: '# index\n' },
      rejected: [],
      skipped: [],
    };

    const written = await applyAdrWritePlan(plan, { root: dir });

    expect(written).toEqual(['docs/adr/0005-x.md', 'docs/adr/README.md']);
    await expect(readFile(join(dir, 'docs/adr/0005-x.md'), 'utf-8')).resolves.toBe('# ADR-0005: X\n');
    await expect(readFile(join(dir, 'docs/adr/README.md'), 'utf-8')).resolves.toBe('# index\n');
  });
});
