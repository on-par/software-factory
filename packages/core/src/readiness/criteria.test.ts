import { describe, expect, it } from 'vitest';
import { assessAcceptanceCriteria, gradeIssueCriteria, hasRunnableCommand } from './criteria.js';

const issue = (ac: string, verification?: string) =>
  `### Acceptance criteria\n\n${ac}\n${verification === undefined ? '' : `\n### Verification\n\n${verification}\n`}`;

describe('assessAcceptanceCriteria', () => {
  it('accepts the When/Then house format as structured', () => {
    const [f] = assessAcceptanceCriteria('- [ ] Structured accepted (When: x — Then: y)');
    expect(f).toMatchObject({ index: 1, grade: 'structured', observable: true });
    expect(f?.note).toBeUndefined();
  });

  it('accepts single-line and multi-line Gherkin', () => {
    const one = assessAcceptanceCriteria('- [ ] Given a user, When they log in, Then they see the dashboard');
    expect(one[0]?.grade).toBe('structured');
    const multi = assessAcceptanceCriteria('- [ ] Given a\n      When b\n      Then c');
    expect(multi).toHaveLength(1);
    expect(multi[0]).toMatchObject({ grade: 'structured', text: 'Given a When b Then c' });
  });

  it('flags a vague criterion as having no observable outcome', () => {
    const [f] = assessAcceptanceCriteria('- [ ] works correctly');
    expect(f).toMatchObject({ grade: 'unstructured', observable: false, note: 'no observable outcome' });
  });

  it('treats a concrete unstructured criterion as observable', () => {
    const [f] = assessAcceptanceCriteria('- [ ] prints `ok`');
    expect(f).toMatchObject({ grade: 'unstructured', observable: true });
    expect(f?.note).toBeUndefined();
  });

  it('grades empty checkboxes as empty', () => {
    expect(assessAcceptanceCriteria('- [ ]')[0]).toMatchObject({ grade: 'empty', observable: false, text: '' });
    expect(assessAcceptanceCriteria('- [ ]   ')[0]?.grade).toBe('empty');
  });

  it('ignores fenced content, prose and non-checkbox items; ends continuation on a new item', () => {
    const f = assessAcceptanceCriteria(
      ['intro', '- plain item', '```', '- [ ] fenced', '```', '- [x] a', '- [ ] b', '', '  stray', '- [ ] c'].join(
        '\n',
      ),
    );
    expect(f.map((x) => x.text)).toEqual(['a', 'b', 'c']);
  });

  it('does not treat a nested list item as a continuation', () => {
    const f = assessAcceptanceCriteria('- [ ] a\n  - sub\n  more');
    expect(f).toHaveLength(1);
    expect(f[0]?.text).toBe('a');
  });
});

describe('hasRunnableCommand', () => {
  it.each([
    ['`npm test`', true],
    ['```\nnpm test\n```', true],
    ['- bash scripts/verify.sh', true],
    ['- [ ] $ npm run test', true],
    ['1. git status', true],
    ['Run the tests and check it works', false],
    ['```\n\n```', false],
    ['``', false],
  ])('%j -> %s', (section, expected) => {
    expect(hasRunnableCommand(section)).toBe(expected);
  });
});

describe('gradeIssueCriteria', () => {
  it('reports an empty criterion', () => {
    const r = gradeIssueCriteria(issue('- [ ]', '`npm test`'));
    expect(r.problems).toEqual(['criterion 1 is empty']);
    expect(r.pass).toBe(false);
  });

  it('reports zero criteria only when the section exists', () => {
    expect(gradeIssueCriteria(issue('just prose')).problems).toContain('no acceptance criteria');
    expect(gradeIssueCriteria('### Verification\n\n`npm test`').problems).not.toContain('no acceptance criteria');
  });

  it('flags a command-less Verification section', () => {
    const r = gradeIssueCriteria(issue('- [ ] prints `ok`', 'Run the tests.'));
    expect(r.verificationCommand).toBe(false);
    expect(r.problems).toEqual(['Verification has no runnable command']);
  });

  it('reports null for a missing Verification section without a problem', () => {
    const r = gradeIssueCriteria(issue('- [ ] prints `ok`'));
    expect(r.verificationCommand).toBeNull();
    expect(r.pass).toBe(true);
  });

  it('grades checked items like unchecked and keeps warnings out of problems', () => {
    const r = gradeIssueCriteria(issue('- [x] works correctly', '`npm test`'));
    expect(r.findings[0]?.grade).toBe('unstructured');
    expect(r.pass).toBe(true);
  });
});
