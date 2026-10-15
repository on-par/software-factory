import { describe, expect, it } from 'vitest';

import {
  buildTriagePrompt,
  dropQueuedIssues,
  normalizeTriageQueue,
  parseOpenPrIssues,
  parseTriageCandidates,
  TRIAGE_BODY_MAX_CHARS,
  truncateTriageBody,
} from './index.js';
import { validateQueue } from '../queue/index.js';

describe('truncateTriageBody', () => {
  it('keeps short bodies and caps long ones at the limit', () => {
    expect(truncateTriageBody('  hi  ')).toBe('hi');
    const cut = truncateTriageBody('y'.repeat(10_000));
    expect(cut.length).toBe(TRIAGE_BODY_MAX_CHARS);
    expect(cut.endsWith('[truncated]')).toBe(true);
  });
});

describe('buildTriagePrompt', () => {
  it('caps every one of 100 10k-character bodies at 1.5k characters', () => {
    const candidates = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: `t${i}`,
      labels: [],
      body: 'z'.repeat(10_000),
    }));
    const prompt = buildTriagePrompt({ repo: 'o/r', candidates });
    for (const block of prompt.split('### #').slice(1)) {
      const body = block.split('\n').slice(1).join('\n').trim();
      expect(body.length).toBeLessThanOrEqual(TRIAGE_BODY_MAX_CHARS);
    }
    expect(prompt).toContain('Reply with ONLY the queue');
  });

  it('names the constitution and handles no issues', () => {
    const prompt = buildTriagePrompt({ repo: 'o/r', product: 'web', candidates: [] });
    expect(prompt).toContain('Active constitution: web.');
    expect(prompt).toContain('(no open issues)');
    expect(buildTriagePrompt({ repo: 'o/r', candidates: [{ number: 1, title: 'a', labels: [], body: '' }] })).toContain(
      '(no body)',
    );
  });
});

describe('parseTriageCandidates', () => {
  it('normalizes gh JSON and skips malformed rows', () => {
    const parsed = parseTriageCandidates(
      JSON.stringify([
        { number: 1, title: 'a', labels: [{ name: 'bug' }, 'x', 3], body: 'b' },
        { number: 2 },
        { title: 'no number' },
        null,
      ]),
    );
    expect(parsed).toEqual([
      { number: 1, title: 'a', labels: ['bug', 'x'], body: 'b' },
      { number: 2, title: '', labels: [], body: '' },
    ]);
    expect(parseTriageCandidates('{}')).toEqual([]);
  });
});

describe('normalizeTriageQueue', () => {
  it('produces a queue validateQueue accepts from messy model output', () => {
    const out = normalizeTriageQueue(
      'Here is the queue:\n```\n# Triage queue\n\n- app 5\napp #6\napp 5\ndocs 0\n```\n',
    );
    expect(out).toBe('# Triage queue\napp 5\napp 6\n');
    expect(validateQueue(out).ok).toBe(true);
  });

  it('returns empty when no entry survives', () => {
    expect(normalizeTriageQueue('# only comments\nnothing here')).toBe('');
  });
});

describe('parseOpenPrIssues', () => {
  it('collects issue numbers from factory and legacy branches only', () => {
    const json = JSON.stringify([
      { headRefName: 'factory/1-foo' },
      { headRefName: 'factory/3-bar' },
      { headRefName: 'feature/5-x' },
      { headRefName: 'ship-it/7-old' },
      {},
      null,
    ]);
    expect(parseOpenPrIssues(json, 'factory')).toEqual(new Set([1, 3, 7]));
  });

  it('yields nothing for malformed input', () => {
    expect(parseOpenPrIssues('not json', 'factory').size).toBe(0);
    expect(parseOpenPrIssues('{}', 'factory').size).toBe(0);
  });
});

describe('dropQueuedIssues', () => {
  const queue = '# Triage queue\napp 1\napp 3\napp 5\ndocs 6\n';

  it('drops #1 and #3 with open factory PRs and keeps #5 (#2981)', () => {
    const issues = parseOpenPrIssues(
      JSON.stringify([{ headRefName: 'factory/1-a' }, { headRefName: 'factory/3-b' }]),
      'factory',
    );
    const out = dropQueuedIssues(queue, issues);
    expect(out).toBe('# Triage queue\napp 5\ndocs 6\n');
    expect(out).toContain('app 5');
    expect(out).not.toMatch(/^app [13]$/m);
    expect(validateQueue(out).ok).toBe(true);
  });

  it('returns the queue unchanged for an empty set', () => {
    expect(dropQueuedIssues(queue, new Set())).toBe(queue);
  });

  it('returns an empty string when every entry is dropped', () => {
    expect(dropQueuedIssues(queue, new Set([1, 3, 5, 6]))).toBe('');
  });
});

describe('normalizeTriageQueue with open PRs', () => {
  it('drops issues owning an open factory PR (#2981)', () => {
    const json = JSON.stringify([{ headRefName: 'factory/1-a' }]);
    expect(normalizeTriageQueue('app 1\napp 5\n', json, 'factory')).toBe('app 5\n');
    expect(normalizeTriageQueue('app 1\napp 5\n')).toBe('app 1\napp 5\n');
  });
});
