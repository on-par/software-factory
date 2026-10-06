import { describe, expect, it } from 'vitest';

import { AdrKitError } from './adr.js';
import {
  ADR_INDEX_END,
  ADR_INDEX_START,
  buildIndexRows,
  diffIndexRows,
  parseIndexTable,
  renderIndexTable,
  replaceIndexBlock,
  upsertIndexRow,
} from './index-table.js';

const REAL_TABLE = `# Architecture Decision Records

## Index

| Number                                                | Title                                                                  | Status   |
| ------------------------------------------------------ | ----------------------------------------------------------------------- | -------- |
| [0001](0001-boss-worker-checker-pipeline.md)          | Boss–worker–checker pipeline with per-issue build routing              | Accepted |
| [0002](0002-structured-logging-via-event-log.md)      | Structured logging via the existing event log, not pino                | Accepted |

Trailing text after the table.
`;

const TABLE_WITH_GAP = `| Number | Title | Status |
| --- | --- | --- |
| [0001](0001-a.md) | First | Accepted |
| [0003](0003-c.md) | Third | Accepted |
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
    const inserted = upsertIndexRow(TABLE_WITH_GAP, {
      number: 2,
      title: 'Second',
      status: 'Accepted',
      href: '0002-b.md',
    });
    const rows = parseIndexTable(inserted);
    expect(rows.map((row) => row.number)).toEqual([1, 2, 3]);
    expect(rows[1].title).toBe('Second');
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

const adrSource = (n: string, title: string, status = 'Accepted') =>
  `# ADR-${n}: ${title}\n\n- Status: ${status}\n- Date: 2026-01-01\n\n## Context\n\nx\n`;

describe('buildIndexRows', () => {
  it('sorts rows by number and keeps duplicate numbers ordered by filename', () => {
    const rows = buildIndexRows([
      { filename: '0002-b.md', source: adrSource('0002', 'Second') },
      { filename: '0001-z.md', source: adrSource('0001', 'Z one') },
      { filename: '0001-a.md', source: adrSource('0001', 'A one', 'Superseded by ADR-0023') },
    ]);
    expect(rows.map((r) => r.href)).toEqual(['0001-a.md', '0001-z.md', '0002-b.md']);
    expect(rows[0]).toEqual({
      number: 1,
      title: 'A one',
      status: 'Superseded by ADR-0023',
      href: '0001-a.md',
    });
  });

  it('keeps identical hrefs stable', () => {
    const file = { filename: '0001-a.md', source: adrSource('0001', 'A') };
    expect(buildIndexRows([file, file])).toHaveLength(2);
  });

  it('names the file when there is no H1', () => {
    expect(() => buildIndexRows([{ filename: '0003-x.md', source: 'no heading\n' }])).toThrow(/0003-x\.md/);
    try {
      buildIndexRows([{ filename: '0003-x.md', source: 'no heading\n' }]);
    } catch (error) {
      expect(error).toBeInstanceOf(AdrKitError);
    }
  });

  it('names the file when no number is available', () => {
    expect(() => buildIndexRows([{ filename: 'x.md', source: '# Title\n\n- Status: Accepted\n' }])).toThrow(
      /x\.md: ADR has no number/,
    );
  });

  it('names the file when the title is empty', () => {
    expect(() => buildIndexRows([{ filename: '0004-x.md', source: '# ADR-0004:   \n\n- Status: Accepted\n' }])).toThrow(
      /0004-x\.md/,
    );
  });

  it('names the file when the status is missing', () => {
    expect(() => buildIndexRows([{ filename: '0005-x.md', source: '# ADR-0005: T\n\nbody\n' }])).toThrow(
      /0005-x\.md: ADR has no Status line/,
    );
  });
});

describe('replaceIndexBlock', () => {
  const doc = (inner: string, eol = '\n') =>
    ['before', ADR_INDEX_START, '', inner, '', ADR_INDEX_END, 'after', ''].join(eol);
  const table = renderIndexTable([{ number: 1, title: 'One', status: 'Accepted', href: '0001-a.md' }]);

  it('replaces only the region between the markers and is idempotent', () => {
    const out = replaceIndexBlock(doc('old stuff'), table);
    expect(out).toBe(doc(table));
    expect(out.startsWith(`before\n${ADR_INDEX_START}`)).toBe(true);
    expect(out.endsWith(`${ADR_INDEX_END}\nafter\n`)).toBe(true);
    expect(replaceIndexBlock(out, table)).toBe(out);
  });

  it('preserves CRLF line endings', () => {
    const out = replaceIndexBlock(doc('old', '\r\n'), table);
    expect(out).toBe(doc(table.replace(/\n/g, '\r\n'), '\r\n'));
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it.each([
    ['missing start', `x\n${ADR_INDEX_END}\n`],
    ['missing end', `x\n${ADR_INDEX_START}\n`],
    ['duplicate start', `${ADR_INDEX_START}\n${ADR_INDEX_START}\n${ADR_INDEX_END}\n`],
    ['duplicate end', `${ADR_INDEX_START}\n${ADR_INDEX_END}\n${ADR_INDEX_END}\n`],
    ['end before start', `${ADR_INDEX_END}\n${ADR_INDEX_START}\n`],
  ])('throws an index error for %s', (_name, markdown) => {
    expect(() => replaceIndexBlock(markdown, table)).toThrow(AdrKitError);
    try {
      replaceIndexBlock(markdown, table);
    } catch (error) {
      expect((error as AdrKitError).code).toBe('index');
    }
  });

  it('adds exactly one row, in number order, when a new ADR appears', () => {
    const file = (n: string) => ({ filename: `${n}-x.md`, source: adrSource(n, `T${n}`) });
    const base = [file('0001'), file('0003'), file('0005')];
    const first = replaceIndexBlock(doc('old'), renderIndexTable(buildIndexRows(base)));
    const second = replaceIndexBlock(first, renderIndexTable(buildIndexRows([...base, file('0004')])));
    const firstLines = first.split('\n');
    const secondLines = second.split('\n');
    expect(secondLines.length).toBe(firstLines.length + 1);
    const added = secondLines.filter((line) => !firstLines.includes(line));
    expect(added).toHaveLength(1);
    expect(added[0]).toContain('[0004]');
    const numbers = parseIndexTable(second).map((r) => r.number);
    expect(numbers).toEqual([1, 3, 4, 5]);
    expect(second.startsWith('before\n')).toBe(true);
    expect(second.endsWith('after\n')).toBe(true);
  });
});

describe('diffIndexRows', () => {
  const row = (n: number, title = 'T', status = 'Accepted') => ({
    number: n,
    title,
    status,
    href: `${String(n).padStart(4, '0')}-x.md`,
  });

  it('reports missing, extra, stale title and stale status rows', () => {
    const lines = diffIndexRows(
      [row(1, 'Old'), row(2, 'T', 'Accepted'), row(99)],
      [row(1, 'New'), row(2, 'T', 'Superseded by ADR-0003'), row(5)],
    );
    expect(lines).toEqual([
      'stale title: 0001 — index has "Old", ADR has "New"',
      'stale status: 0002 — index has "Accepted", ADR has "Superseded by ADR-0003"',
      'missing row: 0005 (0005-x.md)',
      'extra row: 0099 (0099-x.md)',
    ]);
  });

  it('returns nothing for equal rows', () => {
    expect(diffIndexRows([row(1)], [row(1)])).toEqual([]);
  });
});

describe('renderIndexTable escaping', () => {
  it('escapes pipes so parseIndexTable round-trips', () => {
    const rows = [{ number: 1, title: 'A | B', status: 'Accepted | x', href: '0001-a.md' }];
    const table = renderIndexTable(rows);
    expect(table).toContain('A \\| B');
    expect(parseIndexTable(table)).toEqual(rows);
  });

  it('escapes backslashes so a title with \\ and | round-trips', () => {
    const rows = [{ number: 1, title: 'C:\\dir\\ | a\\|b ends\\', status: 'Accepted', href: '0001-a.md' }];
    const table = renderIndexTable(rows);
    expect(table).toContain('C:\\\\dir\\\\ \\| a\\\\\\|b ends\\\\');
    expect(parseIndexTable(table)).toEqual(rows);
  });

  it('does not double backslashes when the same row is upserted repeatedly', () => {
    const row = { number: 1, title: 'Path C:\\x | y', status: 'Accepted', href: '0001-a.md' };
    const once = upsertIndexRow(renderIndexTable([row]), row);
    const twice = upsertIndexRow(once, row);
    expect(twice).toBe(once);
    expect(parseIndexTable(twice)).toEqual([row]);
  });
});
