import { describe, expect, it, vi } from 'vitest';
import { buildIssueCheckReport, formatIssueCheckLines, runIssueCheck } from './ready-check.js';

const body = (criteria: number, opts: { verification?: boolean } = {}) => `### Problem statement

Something is wrong.

### In scope

- Fix it.

### Out of scope

Nothing else.

### Acceptance criteria

${Array.from({ length: criteria }, (_, i) => `- [ ] criterion ${i + 1}`).join('\n')}
${opts.verification === false ? '' : '\n### Verification\n\nbash scripts/verify.sh\n'}`;

function deps(b: string, title = 'Fix it') {
  const lines: string[] = [];
  const getIssue = vi.fn(async () => ({ title, body: b as string | null }));
  return { lines, getIssue, d: { getIssue, log: (l: string) => lines.push(l) } };
}

describe('runIssueCheck', () => {
  it('reports runs-as-is with exit 0', async () => {
    const { lines, d } = deps(body(3));
    const r = await runIssueCheck(7, {}, d);
    expect(r.exitCode).toBe(0);
    expect(r.size.verdict).toBe('runs-as-is');
    expect(lines.join('\n')).toContain('is factory-ready');
    expect(lines).toContain('size: runs as-is');
  });

  it('reports would-split with reason and exit 3', async () => {
    const { lines, d } = deps(body(7));
    const r = await runIssueCheck(7, {}, d);
    expect(r.exitCode).toBe(3);
    expect(r.size.verdict).toBe('would-split');
    expect(r.size.reason).toContain('7 acceptance criteria');
    expect(lines.join('\n')).toContain('would split — too big:');
  });

  it('reports missing fields with exit 1', async () => {
    const { lines, d } = deps(body(3, { verification: false }));
    const r = await runIssueCheck(7, {}, d);
    expect(r.exitCode).toBe(1);
    expect(lines).toContain('  missing: Verification');
  });

  it('exit 1 wins over oversize and lists both reasons', async () => {
    const { d } = deps(body(7, { verification: false }));
    const r = await runIssueCheck(7, {}, d);
    expect(r.exitCode).toBe(1);
    expect(r.reasons).toHaveLength(2);
    expect(r.reasons[0]).toBe('missing: Verification');
    expect(r.reasons[1]).toContain('too big');
  });

  it('prints exactly one JSON object with --json', async () => {
    const { lines, d } = deps(body(7));
    await runIssueCheck(7, { json: true }, d);
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]);
    expect(obj).toMatchObject({ issue: 7, exitCode: 3, size: { verdict: 'would-split' } });
    expect(obj.fields).toEqual({ pass: true, missing: [] });
    expect(obj.reasons).toHaveLength(1);
  });

  it('treats a null body as empty', async () => {
    const { getIssue, d } = deps('');
    getIssue.mockResolvedValueOnce({ title: 'x', body: null });
    const r = await runIssueCheck(7, {}, d);
    expect(r.exitCode).toBe(1);
  });

  it('reports an epic as runs-as-is and only reads once', async () => {
    const { getIssue, d } = deps('### Goal\n\nBig.\n', 'Epic: big');
    const r = await runIssueCheck(7, {}, d);
    expect(r.size.verdict).toBe('runs-as-is');
    expect(getIssue).toHaveBeenCalledTimes(1);
    expect(Object.keys(d).sort()).toEqual(['getIssue', 'log']);
  });
});

describe('buildIssueCheckReport', () => {
  const base = { template: 'factory-task', score: 1, pass: true, missing: [] } as never;
  it('exit-code precedence', () => {
    expect(buildIssueCheckReport(1, { ...(base as object), sizeOk: true } as never).exitCode).toBe(0);
    expect(buildIssueCheckReport(1, { ...(base as object), sizeOk: false } as never)).toMatchObject({
      exitCode: 3,
      size: { reason: 'too big' },
    });
    expect(
      buildIssueCheckReport(1, { ...(base as object), pass: false, missing: ['A'], sizeOk: false } as never).exitCode,
    ).toBe(1);
  });

  it('formats lines', () => {
    const r = buildIssueCheckReport(1, { ...(base as object), sizeOk: false, sizeReason: 'too big: x' } as never);
    expect(formatIssueCheckLines(r)).toEqual([
      'issue #1 is factory-ready (factory-task, score 100%)',
      'size: would split — too big: x',
    ]);
  });
});
