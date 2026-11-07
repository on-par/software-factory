import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '@on-par/factory-core/testing';

import { type BaseHold, formatBaseHoldKept, formatBaseHoldStatus, readBaseHold, writeBaseHold } from './base-hold.js';

const hold: BaseHold = {
  repo: 'on-par/software-factory',
  baseSha: 'abc1234567890def',
  failingChecks: ['tests', 'lint'],
  since: '2026-01-01T00:00:00.000Z',
};

describe('base hold issue (#3851)', () => {
  const tempDirs = createTempDirs();
  afterEach(async () => {
    await tempDirs.cleanup();
  });

  it('issue round-trips through write/read; a non-integer is dropped (#3851)', async () => {
    const file = join(await tempDirs.make('factory-base-hold-issue-'), 'state', 'base-hold.json');
    writeBaseHold(file, { ...hold, issue: 5 });
    expect(readBaseHold(file)?.issue).toBe(5);
    for (const bad of [1.5, 0, -2, '5']) {
      writeFileSync(file, JSON.stringify({ ...hold, issue: bad }));
      expect(readBaseHold(file)?.issue).toBeUndefined();
    }
    writeBaseHold(file, { ...hold, issue: 2.5 });
    expect(readBaseHold(file)?.issue).toBeUndefined();
  });

  it('formatBaseHoldStatus names the waiting issue, base SHA and failing checks (#3851)', () => {
    expect(formatBaseHoldStatus({ ...hold, baseSha: 'abc1234567890def', issue: 7 })).toContain(
      '  waiting: #7 is waiting on red base abc12345 (tests, lint)',
    );
    expect(formatBaseHoldStatus(hold).some((l) => l.includes('waiting:'))).toBe(false);
  });
});

describe('base hold for a base check that could not run', () => {
  const tempDirs = createTempDirs();
  afterEach(async () => {
    await tempDirs.cleanup();
  });
  const EVIDENCE = 'tests: timeout after 300s — `bash scripts/verify.sh --no-e2e`: timed out after 300s';
  const inconclusive: BaseHold = { ...hold, failingChecks: [], inconclusive: true, evidence: EVIDENCE, issue: 7 };

  it('inconclusive and evidence round-trip; wrong types are dropped', async () => {
    const file = join(await tempDirs.make('factory-base-hold-inconclusive-'), 'state', 'base-hold.json');
    writeBaseHold(file, inconclusive);
    expect(readBaseHold(file)).toMatchObject({ inconclusive: true, evidence: EVIDENCE });
    writeFileSync(file, JSON.stringify({ ...inconclusive, inconclusive: 'yes', evidence: 5 }));
    const read = readBaseHold(file);
    expect(read?.inconclusive).toBeUndefined();
    expect(read?.evidence).toBeUndefined();
  });

  it('factory status says the base checks could not run, not a red base, and shows the evidence', () => {
    const lines = formatBaseHoldStatus(inconclusive);
    expect(lines).toContain('  failingChecks: (none — base checks could not run, not a test failure)');
    expect(lines).toContain(`  evidence: ${EVIDENCE}`);
    expect(lines).toContain('  waiting: #7 is waiting: base checks could not run on abc12345 (not a test failure)');
    expect(lines.join('\n')).not.toMatch(/red base|none recorded/);
  });

  it('factory status for a red hold shows the evidence and keeps the red wording', () => {
    const red = 'tests: exit 1 — `bash scripts/verify.sh --no-e2e`: FAIL  src/math.test.ts > add > adds';
    const lines = formatBaseHoldStatus({ ...hold, failingChecks: ['tests'], evidence: red, issue: 7 });
    expect(lines).toContain('  waiting: #7 is waiting on red base abc12345 (tests)');
    expect(lines).toContain(`  evidence: ${red}`);
  });

  it('the kept-hold lane warning says the base checks could not run, with the evidence', () => {
    const msg = formatBaseHoldKept('lane-1', { kind: 'hold', hold: inconclusive, ciReason: 'ci pending' });
    expect(msg).toBe(
      `lane 'lane-1' not claiming: base hold on abc12345 (base checks could not run, not a test failure: ${EVIDENCE}) — origin/main unchanged and its CI is not green (ci pending)`,
    );
  });

  it('the kept-hold lane warning for a red hold adds the evidence after the checks', () => {
    const red = 'tests: exit 1 — `bash scripts/verify.sh --no-e2e`: FAIL  x';
    const msg = formatBaseHoldKept('lane-1', {
      kind: 'hold',
      hold: { ...hold, failingChecks: ['tests'], evidence: red },
    });
    expect(msg).toBe(
      `lane 'lane-1' not claiming: base hold on abc12345 (tests — ${red}) — origin/main unchanged and its CI is not green`,
    );
  });
});
