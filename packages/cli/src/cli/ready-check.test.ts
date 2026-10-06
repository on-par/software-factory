import { scoreIssueReadiness } from '@on-par/factory-core';
import { describe, expect, it, vi } from 'vitest';
import {
  DeepCheckError,
  createDeepModelRunner,
  buildIssueCheckReport,
  formatIssueCheckLines,
  runIssueCheck,
} from './ready-check.js';

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

describe('runIssueCheck INVEST', () => {
  const withDep = body(3).replace('Something is wrong.', 'Something is wrong, depends on #12 because reasons.');

  it('prints invest block without changing exit code', async () => {
    const { lines, d } = deps(withDep);
    const r = await runIssueCheck(7, {}, { ...d, getIssueState: async () => 'open' });
    expect(lines).toContain('invest:');
    expect(lines.join('\n')).toContain('independent: warn — depends on open #12');
    expect(r.exitCode).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it('keeps exit 3 for oversize while small warns', async () => {
    const { d } = deps(body(7));
    const r = await runIssueCheck(7, {}, d);
    expect(r.exitCode).toBe(3);
    expect(r.invest!.findings.find((f) => f.letter === 'small')!.status).toBe('warn');
  });

  it('--json includes six invest findings', async () => {
    const { lines, d } = deps(body(3));
    await runIssueCheck(7, { json: true }, d);
    expect(JSON.parse(lines[0]!).invest.findings).toHaveLength(6);
  });

  it('treats a throwing or absent getIssueState as unknown', async () => {
    const { d } = deps(withDep);
    const thrown = await runIssueCheck(
      7,
      {},
      {
        ...d,
        getIssueState: async () => {
          throw new Error('boom');
        },
      },
    );
    const ind = thrown.invest!.findings[0]!;
    expect(ind.status).toBe('warn');
    expect(ind.reason).toContain('could not check');
    const absent = await runIssueCheck(7, {}, d);
    expect(absent.invest!.findings[0]!.status).toBe('warn');
  });

  it('leaves invest null for non factory-task issues and does no lookups', async () => {
    const getIssueState = vi.fn(async () => 'open' as const);
    const { d } = deps('### Why\n\nbecause. depends on #4\n\n### Children\n\n- #1\n\n### Done when\n\nall', '[Epic] x');
    const r = await runIssueCheck(7, {}, { ...d, getIssueState });
    expect(r.invest).toBeNull();
    expect(getIssueState).not.toHaveBeenCalled();
  });

  it('buildIssueCheckReport defaults invest to null', () => {
    const readiness = scoreIssueReadiness({ title: 'x', body: body(3) });
    expect(buildIssueCheckReport(1, readiness).invest).toBeNull();
  });
});

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

describe('runIssueCheck criteria grading', () => {
  const task = (ac: string, verification = 'bash scripts/verify.sh') => `### Problem statement

Something is wrong.

### In scope

- Fix it.

### Out of scope

Nothing else.

### Acceptance criteria

${ac}

### Verification

${verification}
`;

  it('exits 1 on an empty criterion', async () => {
    const { lines, d } = deps(task('- [ ] prints `ok`\n- [ ]'));
    const r = await runIssueCheck(7, {}, d);
    expect(r.exitCode).toBe(1);
    expect(lines).toContain('criteria:');
    expect(lines).toContain('  2. empty');
    expect(lines.join('\n')).toContain('is not factory-ready');
    expect(r.reasons).toContain('criterion 2 is empty');
  });

  it('exits 1 on command-less Verification', async () => {
    const { lines, d } = deps(task('- [ ] prints `ok`', 'Run the tests and make sure it works.'));
    const r = await runIssueCheck(7, {}, d);
    expect(r.exitCode).toBe(1);
    expect(lines).toContain('  Verification has no runnable command');
    expect(r.reasons).toContain('Verification has no runnable command');
  });

  it('exits 1 on zero criteria', async () => {
    const { lines, d } = deps(task('nothing here'));
    const r = await runIssueCheck(7, {}, d);
    expect(r.exitCode).toBe(1);
    expect(lines).toContain('  no acceptance criteria');
  });

  it('keeps a vague criterion as a warning with exit 0', async () => {
    const { lines, d } = deps(task('- [ ] works correctly'));
    const r = await runIssueCheck(7, {}, d);
    expect(r.exitCode).toBe(0);
    expect(lines.join('\n')).toContain('(no observable outcome)');
  });

  it('includes criteria in --json and null for epics', async () => {
    const { lines, d } = deps(task('- [ ] prints `ok`'));
    await runIssueCheck(7, { json: true }, d);
    const parsed = JSON.parse(lines[0] ?? '{}');
    expect(parsed.criteria.findings[0].grade).toBe('unstructured');
    const epic = deps('### Goal\n\nx\n', 'Epic: big thing');
    const r = await runIssueCheck(8, {}, epic.d);
    expect(r.criteria).toBeNull();
  });

  it('criteria exit 1 wins over oversize', async () => {
    const ac = Array.from({ length: 6 }, (_, i) => `- [ ] criterion ${i + 1}`).join('\n') + '\n- [ ]';
    const { d } = deps(task(ac));
    expect((await runIssueCheck(7, {}, d)).exitCode).toBe(1);
  });
});

const SPLIT_JSON = JSON.stringify({
  epic: { title: 'Epic', why: 'why', doneWhen: ['done'], children: ['Child one'] },
  stories: [
    {
      title: 'Child one',
      role: 'operator',
      want: 'the thing works',
      soThat: 'value',
      problemStatement: 'problem',
      inScope: ['item'],
      outOfScope: ['other'],
      acceptanceCriteria: [{ name: 'Works', given: [], when: ['run'], then: ['it works'] }],
      verification: [{ command: 'npm test', passWhen: 'passes' }],
    },
  ],
});

const GAP_JSON = JSON.stringify({
  missingCriteria: [{ name: 'Covers edge', when: ['input empty'], then: ['prints error'] }],
  unclearScope: ['what is "it"?'],
});

describe('runIssueCheck --deep', () => {
  const model = (output: string, cost: number | null = 0.0123) =>
    vi.fn(async (_task: string, _prompt: string) => ({ model: 'm1', output, cost }));

  it('previews the split without any write dep', async () => {
    const { lines, getIssue } = deps(body(7));
    const runModel = model(SPLIT_JSON);
    const r = await runIssueCheck(7, { deep: true }, { getIssue, log: (l) => lines.push(l), runModel });
    expect(runModel).toHaveBeenCalledTimes(1);
    expect(runModel.mock.calls[0][0]).toBe('decompose');
    expect(r.deep?.kind).toBe('split');
    expect(lines).toContain('  1. Child one');
    expect(lines).toContain('     - Works (When: run — Then: it works)');
    expect(lines.at(-1)).toBe('model: m1, cost: $0.0123');
  });

  it('suggests missing criteria on the triage route', async () => {
    const { lines, getIssue } = deps(body(3));
    const runModel = model(GAP_JSON);
    await runIssueCheck(7, { deep: true }, { getIssue, log: (l) => lines.push(l), runModel });
    expect(runModel).toHaveBeenCalledTimes(1);
    expect(runModel.mock.calls[0][0]).toBe('triage');
    expect(lines).toContain('  - Covers edge (When: input empty — Then: prints error)');
    expect(lines).toContain('unclear scope:');
    expect(lines).not.toContain('negotiable:');
  });

  it('prints (none) when there are no gaps', async () => {
    const { lines, getIssue } = deps(body(3));
    await runIssueCheck(
      7,
      { deep: true },
      { getIssue, log: (l) => lines.push(l), runModel: model('{"missingCriteria":[]}') },
    );
    expect(lines).toContain('  (none)');
  });

  it('rejects invalid output or a failing model without printing a report', async () => {
    const { lines, getIssue } = deps(body(3));
    const log = (l: string) => lines.push(l);
    await expect(runIssueCheck(7, { deep: true }, { getIssue, log, runModel: model('not json') })).rejects.toThrow(
      DeepCheckError,
    );
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(runIssueCheck(7, { deep: true }, { getIssue, log, runModel: failing })).rejects.toThrow(
      /model call failed: boom/,
    );
    await expect(runIssueCheck(7, { deep: true }, { getIssue, log })).rejects.toThrow(DeepCheckError);
    const split = deps(body(7));
    await expect(
      runIssueCheck(7, { deep: true }, { getIssue: split.getIssue, log, runModel: model('not json') }),
    ).rejects.toThrow(/invalid output/);
    expect(lines).toEqual([]);
  });

  it('shows unknown cost when unpriced', async () => {
    const { lines, getIssue } = deps(body(3));
    await runIssueCheck(7, { deep: true }, { getIssue, log: (l) => lines.push(l), runModel: model(GAP_JSON, null) });
    expect(lines.at(-1)).toBe('model: m1, cost: unknown (1 unpriced)');
  });

  it('adds deep to --json only when requested', async () => {
    const a = deps(body(3));
    await runIssueCheck(7, { json: true, deep: true }, { ...a.d, runModel: model(GAP_JSON) });
    expect(JSON.parse(a.lines[0]).deep.model).toBe('m1');
    const b = deps(body(3));
    const runModel = model(GAP_JSON);
    await runIssueCheck(7, { json: true }, { ...b.d, runModel });
    expect(JSON.parse(b.lines[0])).not.toHaveProperty('deep');
    expect(runModel).not.toHaveBeenCalled();
  });
});

describe('createDeepModelRunner', () => {
  it('returns the model, output, and the cost captured by the sink', async () => {
    let sink: (e: { cost: number | null }) => void = () => {};
    const router = {
      setCostSink: (s: typeof sink) => {
        sink = s;
      },
      run: vi.fn(async () => {
        sink({ cost: 0.5 });
        return { model: 'm9', output: 'out' };
      }),
    };
    const run = createDeepModelRunner(router, '/repo');
    expect(await run('triage', 'p')).toEqual({ model: 'm9', output: 'out', cost: 0.5 });
    expect(router.run).toHaveBeenCalledWith('triage', 'p', { worktree: '/repo', timeoutSeconds: 600 });
  });

  it('reports a null cost when the sink never fires', async () => {
    const router = { setCostSink: () => {}, run: async () => ({ model: 'm', output: 'o' }) };
    expect((await createDeepModelRunner(router, '/r')('decompose', 'p')).cost).toBeNull();
  });
});
