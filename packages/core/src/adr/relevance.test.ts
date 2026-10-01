// src/adr/relevance.test.ts — extractCitedPaths / rankAdrsByRelevance tests (#1722).
import { describe, expect, it } from 'vitest';

import type { ActiveAdr } from './index.js';
import { extractCitedPaths, rankAdrsByRelevance } from './relevance.js';

function adr(number: number | undefined, title: string): ActiveAdr {
  const n = number === undefined ? 'x' : String(number);
  return { number, title, status: 'Accepted', date: '2026-07-20', path: `docs/adr/${n}.md`, decision: '' };
}

const SHIP = 'packages/core/src/phases/ship.ts';

describe('extractCitedPaths', () => {
  it('picks up a backticked file path', () => {
    expect(extractCitedPaths(`See \`${SHIP}\` for details.`).files).toEqual([SHIP]);
  });

  it('treats trailing-slash and bare directories as the same dir', () => {
    const r = extractCitedPaths('Use packages/core/src/queue/ and packages/core/src/queue here.');
    expect(r.dirs).toEqual(['packages/core/src/queue']);
    expect(r.files).toEqual([]);
  });

  it('ignores URLs and domain-like tokens', () => {
    const r = extractCitedPaths('https://github.com/on-par/x/issues/1 and github.com/x/y');
    expect(r).toEqual({ files: [], dirs: [] });
  });

  it('keeps dot-prefixed directories', () => {
    expect(extractCitedPaths('Edit .factory/config.yaml now').files).toEqual(['.factory/config.yaml']);
  });

  it('strips trailing punctuation and leading ./', () => {
    expect(extractCitedPaths('(see ./src/phases/ship.ts).').files).toEqual(['src/phases/ship.ts']);
  });

  it('dedupes', () => {
    expect(extractCitedPaths('a/b.ts a/b.ts a/c a/c').files).toEqual(['a/b.ts']);
    expect(extractCitedPaths('a/b.ts a/b.ts a/c a/c').dirs).toEqual(['a/c']);
  });
});

describe('rankAdrsByRelevance', () => {
  it('ranks a cited file above a newer dir citation', () => {
    const old = { adr: adr(3, 'Old'), text: `Touches ${SHIP}` };
    const newer = { adr: adr(90, 'Newer'), text: 'Touches packages/core/src/phases' };
    const r = rankAdrsByRelevance([newer, old], [SHIP]);
    expect(r.map((m) => [m.adr.number, m.reason])).toEqual([
      [3, 'cites-file'],
      [90, 'cites-dir'],
    ]);
    expect(r[0]?.changedPath).toBe(SHIP);
  });

  it('ranks keyword below cites-dir', () => {
    const kw = { adr: adr(50, 'Ship phase pushes branches'), text: 'nothing' };
    const dir = { adr: adr(1, 'Other'), text: 'packages/core/src/phases/' };
    const r = rankAdrsByRelevance([kw, dir], [SHIP]);
    expect(r.map((m) => m.reason)).toEqual(['cites-dir', 'keyword']);
  });

  it('uses the parent dir name for index.ts', () => {
    const c = { adr: adr(1, 'Queue semantics'), text: '' };
    expect(rankAdrsByRelevance([c], ['packages/core/src/queue/index.ts'])[0]?.reason).toBe('keyword');
  });

  it('strips test suffixes for the module name', () => {
    const c = { adr: adr(1, 'Github queue design'), text: '' };
    expect(rankAdrsByRelevance([c], ['a/github-queue.test.ts'])[0]?.reason).toBe('keyword');
  });

  it('gives no keyword match for generic or short module names', () => {
    const c = [
      { adr: adr(1, 'Utils everywhere'), text: '' },
      { adr: adr(2, 'Go to it'), text: '' },
    ];
    expect(rankAdrsByRelevance(c, ['a/utils.ts', 'a/go.ts'])).toEqual([]);
  });

  it('matches package-relative suffix citations', () => {
    const c = { adr: adr(1, 'X'), text: 'src/phases/ship.ts' };
    expect(rankAdrsByRelevance([c], [SHIP])[0]?.reason).toBe('cites-file');
  });

  it('excludes non-matching ADRs', () => {
    expect(rankAdrsByRelevance([{ adr: adr(1, 'Unrelated'), text: 'a/b.ts' }], [SHIP])).toEqual([]);
  });

  it('orders ties newest first, unnumbered last', () => {
    const cs = [1, undefined, 7].map((n) => ({ adr: adr(n, 'T'), text: SHIP }));
    expect(rankAdrsByRelevance(cs, [SHIP]).map((m) => m.adr.number)).toEqual([7, 1, undefined]);
  });

  it('orders unnumbered ties by path', () => {
    const a = { adr: { ...adr(undefined, 'T'), path: 'b.md' }, text: SHIP };
    const b = { adr: { ...adr(undefined, 'T'), path: 'a.md' }, text: SHIP };
    expect(rankAdrsByRelevance([a, b], [SHIP]).map((m) => m.adr.path)).toEqual(['a.md', 'b.md']);
  });

  it('normalizes ./ and backslashes in changed paths', () => {
    const c = { adr: adr(1, 'X'), text: SHIP };
    expect(rankAdrsByRelevance([c], ['.\\packages\\core\\src\\phases\\ship.ts', ''])).toHaveLength(1);
    expect(rankAdrsByRelevance([c], [`./${SHIP}`])).toHaveLength(1);
  });
});
