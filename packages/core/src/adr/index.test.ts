// src/adr/index.test.ts — readAdrContext / renderAdrConstraints tests (#481).
import { createInMemoryReader } from '@on-par/repo-context';
import { describe, expect, it } from 'vitest';

import { readAdrContext, renderAdrConstraints } from './index.js';

function accepted(number: string, title: string, decision: string): string {
  return `# ADR-${number}: ${title}

- Status: Accepted
- Date: 2026-07-20

## Context

Context text.

## Decision

${decision}

## Consequences

Consequences text.
`;
}

function withStatus(number: string, title: string, status: string): string {
  return `# ADR-${number}: ${title}

- Status: ${status}
- Date: 2026-07-20

## Context

Context text.

## Decision

Decision text.

## Consequences

Consequences text.
`;
}

describe('readAdrContext', () => {
  it('returns an Accepted ADR with its number, title, date, path, and decision', async () => {
    const reader = createInMemoryReader({
      'docs/adr/0001-pipeline.md': accepted('0001', 'Boss-worker-checker pipeline', 'Use a boss-worker pipeline.'),
    });

    const ctx = await readAdrContext(reader);

    expect(ctx.active).toEqual([
      {
        number: 1,
        title: 'Boss-worker-checker pipeline',
        status: 'Accepted',
        date: '2026-07-20',
        path: 'docs/adr/0001-pipeline.md',
        decision: 'Use a boss-worker pipeline.',
      },
    ]);
    expect(ctx.scanned).toBe(1);
    expect(ctx.truncated).toBe(0);
  });

  it('excludes non-Accepted statuses and records them as inactive', async () => {
    const reader = createInMemoryReader({
      'docs/adr/0001-a.md': withStatus('0001', 'Proposed one', 'Proposed'),
      'docs/adr/0002-b.md': withStatus('0002', 'Rejected one', 'Rejected'),
      'docs/adr/0003-c.md': withStatus('0003', 'Deprecated one', 'Deprecated'),
      'docs/adr/0004-d.md': withStatus('0004', 'Superseded one', 'Superseded by ADR-0007'),
    });

    const ctx = await readAdrContext(reader);

    expect(ctx.active).toEqual([]);
    expect(ctx.skipped).toEqual([
      { path: 'docs/adr/0001-a.md', reason: 'inactive' },
      { path: 'docs/adr/0002-b.md', reason: 'inactive' },
      { path: 'docs/adr/0003-c.md', reason: 'inactive' },
      { path: 'docs/adr/0004-d.md', reason: 'inactive' },
    ]);
  });

  it('does not scan README/index/template files or non-markdown files, and records unparsable ones', async () => {
    const reader = createInMemoryReader({
      'docs/adr/README.md': '# ADR index\n\nSee below.\n',
      'docs/adr/index.md': '# Index\n',
      'docs/adr/template.md': '# Template\n',
      'docs/adr/_template.md': '# Underscore template\n',
      'docs/adr/notes.txt': 'not markdown',
      'docs/adr/0001-broken.md': 'no h1 heading here',
    });

    const ctx = await readAdrContext(reader);

    expect(ctx.scanned).toBe(1);
    expect(ctx.active).toEqual([]);
    expect(ctx.skipped).toEqual([{ path: 'docs/adr/0001-broken.md', reason: 'unparsable' }]);
  });

  it('yields an empty context and empty render when docs/adr is absent', async () => {
    const reader = createInMemoryReader({ 'README.md': 'root' });

    const ctx = await readAdrContext(reader);

    expect(ctx.active).toEqual([]);
    expect(ctx.scanned).toBe(0);
    expect(renderAdrConstraints(ctx)).toBe('');
  });

  it('sorts unnumbered ADRs after numbered ones and applies the maxAdrs cap', async () => {
    const unnumbered = accepted('', 'Unnumbered decision', 'Decision text.').replace('# ADR-: ', '# ');
    const reader = createInMemoryReader({
      'docs/adr/0002-second.md': accepted('0002', 'Second decision', 'Second.'),
      'docs/adr/0001-first.md': accepted('0001', 'First decision', 'First.'),
      'docs/adr/z-unnumbered.md': unnumbered,
    });

    const full = await readAdrContext(reader);
    expect(full.active.map((a) => a.path)).toEqual([
      'docs/adr/0001-first.md',
      'docs/adr/0002-second.md',
      'docs/adr/z-unnumbered.md',
    ]);

    const capped = await readAdrContext(reader, { maxAdrs: 1 });
    expect(capped.active).toHaveLength(1);
    expect(capped.active[0]?.path).toBe('docs/adr/0001-first.md');
    expect(capped.truncated).toBe(2);
    expect(renderAdrConstraints(capped)).toContain('2 more Accepted ADR(s) omitted by the injection cap');
  });
});

describe('renderAdrConstraints', () => {
  it('renders ADR label, title, path, condensed decision, and the do-not-diverge instruction', async () => {
    const reader = createInMemoryReader({
      'docs/adr/0001-pipeline.md': accepted('0001', 'Boss-worker-checker pipeline', 'Use a boss-worker pipeline.'),
    });
    const ctx = await readAdrContext(reader);

    const rendered = renderAdrConstraints(ctx);

    expect(rendered).toContain('ADR-0001');
    expect(rendered).toContain('Boss-worker-checker pipeline');
    expect(rendered).toContain('docs/adr/0001-pipeline.md');
    expect(rendered).toContain('Use a boss-worker pipeline.');
    expect(rendered).toContain('do NOT silently diverge');
  });

  it('collapses newlines and truncates a decision longer than maxDecisionChars', async () => {
    const longDecision = `Line one.\nLine two.\n${'x'.repeat(50)}`;
    const reader = createInMemoryReader({
      'docs/adr/0001-long.md': accepted('0001', 'Long decision', longDecision),
    });
    const ctx = await readAdrContext(reader);

    const rendered = renderAdrConstraints(ctx, { maxDecisionChars: 20 });
    const condensed = longDecision.replace(/\s+/g, ' ').trim();

    expect(rendered).not.toContain('\nLine two');
    expect(rendered).toContain(`${condensed.slice(0, 20)}…`);
  });
});
