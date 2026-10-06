import { describe, expect, it } from 'vitest';
import { checkIssueSize } from './size.js';
import {
  findIssueDependencies,
  gradeIssueInvest,
  MIN_PROBLEM_STATEMENT_CHARS,
  type IssueInvestReport,
  type IssueDependencyState,
} from './invest.js';

const LONG_PS =
  'Operators cannot tell whether an issue is well formed before queueing it, because nothing reports it today.';

const body = (opts: { ps?: string | null; criteria?: string[]; extra?: string; inScope?: string[] } = {}): string => {
  const ps = opts.ps === undefined ? LONG_PS : opts.ps;
  const criteria = opts.criteria ?? ['When run, then it exits 0'];
  const inScope = opts.inScope ?? ['Fix it.'];
  return `${ps === null ? '' : `### Problem statement\n\n${ps}\n\n`}### In scope

${inScope.map((s) => `- ${s}`).join('\n')}

### Out of scope

Nothing else. ${opts.extra ?? ''}

### Acceptance criteria

${criteria.map((c) => `- [ ] ${c}`).join('\n')}

### Verification

bash scripts/verify.sh
`;
};

const find = (r: IssueInvestReport, letter: string) => r.findings.find((f) => f.letter === letter)!;
const states = (...e: [number, IssueDependencyState][]) => new Map(e);

describe('findIssueDependencies', () => {
  it('detects depends on / after / blocked by, case-insensitively', () => {
    expect(findIssueDependencies('Depends on #12. After #7 lands. BLOCKED BY #9')).toEqual([12, 7, 9]);
  });
  it('de-duplicates and ignores fenced blocks', () => {
    expect(findIssueDependencies('after #3\nafter #3\n```\nafter #99\n```\n')).toEqual([3]);
  });
  it('returns [] when none', () => {
    expect(findIssueDependencies('nothing here')).toEqual([]);
  });
});

describe('gradeIssueInvest', () => {
  it('returns six findings in I-N-V-E-S-T order', () => {
    expect(gradeIssueInvest(body()).findings.map((f) => f.letter)).toEqual([
      'independent',
      'negotiable',
      'valuable',
      'estimable',
      'small',
      'testable',
    ]);
  });

  it('warns on an open dependency', () => {
    const r = gradeIssueInvest(body({ extra: 'Depends on #12.' }), states([12, 'open']));
    expect(find(r, 'independent').status).toBe('warn');
    expect(find(r, 'independent').reason).toContain('#12');
  });

  it('passes a closed dependency', () => {
    const r = gradeIssueInvest(body({ extra: 'Depends on #12.' }), states([12, 'closed']));
    expect(find(r, 'independent').status).toBe('pass');
  });

  it('warns when dependency state is missing or unknown', () => {
    const b = body({ extra: 'after #7' });
    expect(find(gradeIssueInvest(b), 'independent').reason).toContain('could not check');
    expect(find(gradeIssueInvest(b, states([7, 'unknown'])), 'independent').status).toBe('warn');
  });

  it('passes with no dependencies', () => {
    expect(find(gradeIssueInvest(body()), 'independent').status).toBe('pass');
  });

  it('Small reuses the size gate verbatim', () => {
    const criteria = Array.from({ length: 7 }, (_, i) => `criterion ${i + 1}`);
    const r = gradeIssueInvest(body({ criteria }));
    const expected = checkIssueSize({
      inScope: '- Fix it.',
      acceptanceCriteria: criteria.map((c) => `- [ ] ${c}`).join('\n'),
    });
    expect(find(r, 'small').status).toBe('warn');
    expect(find(r, 'small').reason).toBe(expected.reason);
    expect(find(r, 'small').reason).toBe('too big: 1 in-scope items, 7 acceptance criteria');
    expect(find(gradeIssueInvest(body()), 'small').status).toBe('pass');
  });

  it('Negotiable and Estimable are always not-checked', () => {
    for (const b of [body(), body({ ps: null }), '']) {
      const r = gradeIssueInvest(b);
      for (const l of ['negotiable', 'estimable']) {
        expect(find(r, l).status).toBe('not-checked');
        expect(find(r, l).reason).toBe('needs model judgement');
      }
    }
  });

  it('Valuable warns on missing, short, or cue-less statements; passes otherwise', () => {
    expect(find(gradeIssueInvest(body({ ps: null })), 'valuable').reason).toBe('no Problem statement');
    const short = find(gradeIssueInvest(body({ ps: 'Too short.' })), 'valuable');
    expect(short.reason).toContain(`< ${MIN_PROBLEM_STATEMENT_CHARS} chars`);
    const noCue = 'Operators look at the issue list every morning and see many items with various labels attached.';
    expect(find(gradeIssueInvest(body({ ps: noCue })), 'valuable').reason).toContain('does not say why');
    expect(find(gradeIssueInvest(body()), 'valuable').status).toBe('pass');
  });

  it('Testable warns on missing, empty, and vague criteria; passes structured ones', () => {
    expect(find(gradeIssueInvest(body({ criteria: [] })), 'testable').reason).toBe('no acceptance criteria');
    expect(find(gradeIssueInvest(body({ criteria: ['When x, then y', ''] })), 'testable').reason).toBe(
      'criterion 2 is empty',
    );
    const vague = find(gradeIssueInvest(body({ criteria: ['When x, then y', 'it is good'] })), 'testable');
    expect(vague.reason).toBe('criterion 2 has no observable outcome');
    expect(find(gradeIssueInvest(body()), 'testable')).toMatchObject({
      status: 'pass',
      reason: '1 criteria are checkable',
    });
  });
});
