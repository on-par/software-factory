// packages/product/src/architecture/adrs.test.ts (#477).
import { createInMemoryReader } from '@on-par/repo-context';
import type { RepoContextReader } from '@on-par/repo-context';
import { describe, expect, it } from 'vitest';

import { readActiveAdrs } from './adrs.js';

function adr(number: string, title: string, status: string, decision = 'Decision text.'): string {
  return `# ADR-${number}: ${title}

- Status: ${status}
- Date: 2026-07-20

## Context

Context text.

## Decision

${decision}

## Consequences

Consequences text.
`;
}

describe('readActiveAdrs', () => {
  it('parses Accepted ADRs from the target repo docs/adr', async () => {
    const reader = createInMemoryReader({
      'docs/adr/0004-narrow-public-core-api.md': adr('0004', 'Narrow public core API', 'Accepted', 'Keep core narrow.'),
    });

    const adrs = await readActiveAdrs(reader);

    expect(adrs).toEqual([
      {
        label: 'ADR-0004',
        number: 4,
        title: 'Narrow public core API',
        path: 'docs/adr/0004-narrow-public-core-api.md',
        decision: 'Keep core narrow.',
      },
    ]);
  });

  it('skips README.md, index.md, template.md, and _template.md', async () => {
    const reader = createInMemoryReader({
      'docs/adr/README.md': 'not an adr',
      'docs/adr/index.md': 'not an adr',
      'docs/adr/template.md': 'not an adr',
      'docs/adr/_template.md': 'not an adr',
      'docs/adr/0001-real.md': adr('0001', 'Real ADR', 'Accepted'),
    });

    const adrs = await readActiveAdrs(reader);

    expect(adrs.map((a) => a.label)).toEqual(['ADR-0001']);
  });

  it('skips non-.md files', async () => {
    const reader = createInMemoryReader({
      'docs/adr/notes.txt': 'not an adr',
    });

    expect(await readActiveAdrs(reader)).toEqual([]);
  });

  it('skips unparsable files', async () => {
    const reader = createInMemoryReader({
      'docs/adr/0001-broken.md': 'not a valid adr document at all',
    });

    expect(await readActiveAdrs(reader)).toEqual([]);
  });

  it('skips Proposed and Superseded ADRs', async () => {
    const reader = createInMemoryReader({
      'docs/adr/0001-proposed.md': adr('0001', 'Proposed one', 'Proposed'),
      'docs/adr/0002-superseded.md': adr('0002', 'Superseded one', 'Superseded by ADR-0003'),
      'docs/adr/0003-accepted.md': adr('0003', 'Accepted one', 'Accepted'),
    });

    const adrs = await readActiveAdrs(reader);

    expect(adrs.map((a) => a.label)).toEqual(['ADR-0003']);
  });

  it('labels a numbered ADR as ADR-NNNN and an unnumbered ADR by its path', async () => {
    const reader = createInMemoryReader({
      'docs/adr/0004-numbered.md': adr('0004', 'Numbered', 'Accepted'),
      'docs/adr/unnumbered.md': `# Unnumbered decision

- Status: Accepted
- Date: 2026-07-20

## Context

Context text.

## Decision

Decision text.

## Consequences

Consequences text.
`,
    });

    const adrs = await readActiveAdrs(reader);

    expect(adrs.map((a) => a.label).sort()).toEqual(['ADR-0004', 'docs/adr/unnumbered.md']);
  });

  it('sorts ascending by number, unnumbered last, ties broken by path', async () => {
    const unnumbered = (name: string): string => `# ${name}

- Status: Accepted
- Date: 2026-07-20

## Context

Context text.

## Decision

Decision text.

## Consequences

Consequences text.
`;

    const reader = createInMemoryReader({
      'docs/adr/0003-third.md': adr('0003', 'Third', 'Accepted'),
      'docs/adr/0001-first.md': adr('0001', 'First', 'Accepted'),
      'docs/adr/b-unnumbered.md': unnumbered('B unnumbered'),
      'docs/adr/a-unnumbered.md': unnumbered('A unnumbered'),
    });

    const adrs = await readActiveAdrs(reader);

    expect(adrs.map((a) => a.path)).toEqual([
      'docs/adr/0001-first.md',
      'docs/adr/0003-third.md',
      'docs/adr/a-unnumbered.md',
      'docs/adr/b-unnumbered.md',
    ]);
  });

  it('honors a custom dir', async () => {
    const reader = createInMemoryReader({
      'custom/adr-home/0001-first.md': adr('0001', 'First', 'Accepted'),
    });

    const adrs = await readActiveAdrs(reader, { dir: 'custom/adr-home' });

    expect(adrs.map((a) => a.label)).toEqual(['ADR-0001']);
  });

  it('returns [] when the ADR dir is missing', async () => {
    const reader = createInMemoryReader({});

    expect(await readActiveAdrs(reader)).toEqual([]);
  });

  it('skips a candidate whose readFile degrades to undefined', async () => {
    const reader: RepoContextReader = {
      readDir: async () => [{ name: 'ghost.md', path: 'docs/adr/ghost.md', type: 'file' }],
      readFile: async () => undefined,
      exists: async () => false,
    };

    expect(await readActiveAdrs(reader)).toEqual([]);
  });

  it('breaks a tie between two ADRs sharing a number by path (pre-sorted input)', async () => {
    const reader = createInMemoryReader({
      'docs/adr/0001-a.md': adr('0001', 'A', 'Accepted'),
      'docs/adr/0001-b.md': adr('0001', 'B', 'Accepted'),
    });

    const adrs = await readActiveAdrs(reader);

    expect(adrs.map((a) => a.path)).toEqual(['docs/adr/0001-a.md', 'docs/adr/0001-b.md']);
  });

  it('breaks a tie between two ADRs sharing a number by path (reverse input order)', async () => {
    const files: Record<string, string> = {
      'docs/adr/0001-b.md': adr('0001', 'B', 'Accepted'),
      'docs/adr/0001-a.md': adr('0001', 'A', 'Accepted'),
    };
    const reader: RepoContextReader = {
      readDir: async () => [
        { name: '0001-b.md', path: 'docs/adr/0001-b.md', type: 'file' },
        { name: '0001-a.md', path: 'docs/adr/0001-a.md', type: 'file' },
      ],
      readFile: async (path) => {
        const text = files[path];
        return text === undefined ? undefined : { path, text, size: text.length };
      },
      exists: async () => true,
    };

    const adrs = await readActiveAdrs(reader);

    expect(adrs.map((a) => a.path)).toEqual(['docs/adr/0001-a.md', 'docs/adr/0001-b.md']);
  });

  it('sorts a numbered ADR ahead of an unnumbered one regardless of comparator argument order', async () => {
    const files: Record<string, string> = {
      'docs/adr/unnumbered.md': `# Unnumbered

- Status: Accepted
- Date: 2026-07-20

## Context

Context text.

## Decision

Decision text.

## Consequences

Consequences text.
`,
      'docs/adr/0001-x.md': adr('0001', 'X', 'Accepted'),
    };
    const reader: RepoContextReader = {
      readDir: async () => [
        { name: 'unnumbered.md', path: 'docs/adr/unnumbered.md', type: 'file' },
        { name: '0001-x.md', path: 'docs/adr/0001-x.md', type: 'file' },
      ],
      readFile: async (path) => {
        const text = files[path];
        return text === undefined ? undefined : { path, text, size: text.length };
      },
      exists: async () => true,
    };

    const adrs = await readActiveAdrs(reader);

    expect(adrs.map((a) => a.path)).toEqual(['docs/adr/0001-x.md', 'docs/adr/unnumbered.md']);
  });

  it('breaks a tie between two unnumbered ADRs by path (reverse input order)', async () => {
    const unnumbered = (title: string): string => `# ${title}

- Status: Accepted
- Date: 2026-07-20

## Context

Context text.

## Decision

Decision text.

## Consequences

Consequences text.
`;
    const files: Record<string, string> = {
      'docs/adr/b-unnumbered.md': unnumbered('B unnumbered'),
      'docs/adr/a-unnumbered.md': unnumbered('A unnumbered'),
    };
    const reader: RepoContextReader = {
      readDir: async () => [
        { name: 'b-unnumbered.md', path: 'docs/adr/b-unnumbered.md', type: 'file' },
        { name: 'a-unnumbered.md', path: 'docs/adr/a-unnumbered.md', type: 'file' },
      ],
      readFile: async (path) => {
        const text = files[path];
        return text === undefined ? undefined : { path, text, size: text.length };
      },
      exists: async () => true,
    };

    const adrs = await readActiveAdrs(reader);

    expect(adrs.map((a) => a.path)).toEqual(['docs/adr/a-unnumbered.md', 'docs/adr/b-unnumbered.md']);
  });
});
