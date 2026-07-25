import { describe, expect, it } from 'vitest';

import { AdrKitError } from './adr.js';
import { parseIndexTable, renderIndexTable, upsertIndexRow } from './index-table.js';

const REAL_TABLE = `# Architecture Decision Records

## Index

| Number                                                | Title                                                                  | Status   |
| ------------------------------------------------------ | ----------------------------------------------------------------------- | -------- |
| [0001](0001-boss-worker-checker-pipeline.md)          | Boss–worker–checker pipeline with per-issue build routing              | Accepted |
| [0002](0002-structured-logging-via-event-log.md)      | Structured logging via the existing event log, not pino                | Accepted |

Trailing text after the table.
`;

describe('parseIndexTable', () => {
  it('parses the real docs/adr/README.md table shape', () => {
    const rows = parseIndexTable(REAL_TABLE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      number: 1,
      title: 'Boss–worker–checker pipeline with per-issue build routing',
      status: 'Accepted',
      href: '0001-boss-worker-checker-pipeline.md',
    });
    expect(rows[1].number).toBe(2);
  });

  it('returns [] when there is no matching table', () => {
    expect(parseIndexTable('# No table here\n\nJust prose.\n')).toEqual([]);
  });

  it('unescapes a literal pipe inside a cell', () => {
    const table = `| Number | Title | Status |
| --- | --- | --- |
| [0001](0001-x.md) | A \\| B | Accepted |
`;
    expect(parseIndexTable(table)[0].title).toBe('A | B');
  });

  it('falls back to a bare integer with an empty href when the first cell is not a link', () => {
    const table = `| Number | Title | Status |
| --- | --- | --- |
| 7 | Bare number row | Accepted |
`;
    expect(parseIndexTable(table)[0]).toEqual({ number: 7, title: 'Bare number row', status: 'Accepted', href: '' });
  });

  it('skips a row whose first cell yields no number', () => {
    const table = `| Number | Title | Status |
| --- | --- | --- |
| not-a-number | Skipped row | Accepted |
`;
    expect(parseIndexTable(table)).toEqual([]);
  });
});

describe('renderIndexTable', () => {
  it('pads columns to match Prettier output', () => {
    const rendered = renderIndexTable(parseIndexTable(REAL_TABLE));
    const lines = rendered.split('\n');
    expect(lines[0].length).toBe(lines[1].length);
    expect(lines[0].length).toBe(lines[2].length);
    expect(lines[1]).toMatch(/^\| -+ \| -+ \| -+ \|$/);
  });

  it('renders a bare number (no href) without brackets', () => {
    const rendered = renderIndexTable([{ number: 7, title: 'Bare', status: 'Accepted', href: '' }]);
    expect(rendered).toContain('| 7 ');
  });
});

describe('upsertIndexRow', () => {
  it('replaces a row with a matching number in place', () => {
    const updated = upsertIndexRow(REAL_TABLE, {
      number: 1,
      title: 'Renamed decision',
      status: 'Superseded',
      href: '0001-renamed.md',
    });
    const rows = parseIndexTable(updated);
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('Renamed decision');
    expect(rows[0].status).toBe('Superseded');
  });

  it('inserts a new row in ascending order when the number is between existing rows', () => {
    const updated = upsertIndexRow(REAL_TABLE, {
      number: 2,
      title: 'nope',
      status: 'nope',
      href: 'x.md',
    });
    void updated;
    const inserted = upsertIndexRow(REAL_TABLE, {
      number: 3,
      title: 'Third decision',
      status: 'Accepted',
      href: '0003-third.md',
    });
    const rows = parseIndexTable(inserted);
    expect(rows.map((row) => row.number)).toEqual([1, 2, 3]);
  });

  it('inserts a new lowest-numbered row at the start', () => {
    const inserted = upsertIndexRow(REAL_TABLE, {
      number: 0,
      title: 'Zeroth',
      status: 'Accepted',
      href: '0000-zeroth.md',
    });
    const rows = parseIndexTable(inserted);
    expect(rows.map((row) => row.number)).toEqual([0, 1, 2]);
  });

  it('inserts a new highest-numbered row at the end', () => {
    const inserted = upsertIndexRow(REAL_TABLE, {
      number: 9,
      title: 'Ninth',
      status: 'Accepted',
      href: '0009-ninth.md',
    });
    const rows = parseIndexTable(inserted);
    expect(rows.map((row) => row.number)).toEqual([1, 2, 9]);
  });

  it('leaves text before and after the table unchanged', () => {
    const updated = upsertIndexRow(REAL_TABLE, {
      number: 9,
      title: 'Ninth',
      status: 'Accepted',
      href: '0009-ninth.md',
    });
    expect(updated.startsWith('# Architecture Decision Records')).toBe(true);
    expect(updated.trimEnd().endsWith('Trailing text after the table.')).toBe(true);
  });

  it('throws AdrKitError with code index when there is no table', () => {
    expect(() => upsertIndexRow('# No table\n', { number: 1, title: 'x', status: 'x', href: 'x.md' })).toThrow(
      AdrKitError,
    );
    try {
      upsertIndexRow('# No table\n', { number: 1, title: 'x', status: 'x', href: 'x.md' });
      expect.unreachable();
    } catch (error) {
      expect((error as AdrKitError).code).toBe('index');
    }
  });
});
