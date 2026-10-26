// Factory prompts are self-contained: a rendered prompt references only its own text and repo
// files it names by path — never a leading slash-command token or a user-level Claude Code
// skill. Constitutions (#721) are the per-repo extension point; skills are not.

import { workKeyFromIssue } from '../work/work-key.js';
import { describe, expect, it } from 'vitest';

import type { CheckSummary } from '../types/index.js';
import { buildClaudePrompt, buildCommitOnlyPrompt, buildLocalSmallPrompt, buildOpencodePrompt } from './build.js';
import { READ_BEFORE_EDIT_RULE } from './build-lint-rules.js';
import { REWORK_READ_RULE, reworkWorker } from './check.js';
import { buildPlanPrompt } from './plan.js';

// Known Claude Code skills that live under ~/.claude/skills and must never be
// referenced from a factory prompt. Add real skill names here as they appear.
const SKILL_NAMES = ['ship-it'];

// A skill *reference* is a slash-command token (`/ship-it`), a possessive
// (`ship-it's`), or a "<name> skill" phrase — NOT the `ship-it/<issue>` git
// branch prefix (slash *after* the name, followed by a digit).
function skillReference(name: string): RegExp {
  return new RegExp(String.raw`(^|\s)/${name}\b|\b${name}['’]s\b|\b${name}\s+skill\b`);
}

const builders: Array<{ name: string; render: () => string }> = [
  {
    name: 'buildPlanPrompt',
    render: () =>
      buildPlanPrompt({
        issue: workKeyFromIssue(962),
        issueTitle: 'sample',
        issueBody: 'sample body',
        specPath: '.factory/plans/issue-962.md',
        constitutionCtx: '',
      }),
  },
  {
    name: 'buildClaudePrompt',
    render: () =>
      buildClaudePrompt({
        issue: workKeyFromIssue(962),
        branch: 'ship-it/962-factory-build-prompt-carries-no',
        specPath: '.factory/plans/issue-962.md',
        constitutionCtx: '',
      }),
  },
  {
    name: 'buildCommitOnlyPrompt',
    render: () =>
      buildCommitOnlyPrompt({
        issue: workKeyFromIssue(962),
        specPath: '.factory/plans/issue-962.md',
        constitutionCtx: '',
        spec: '# spec',
      }),
  },
  {
    name: 'buildOpencodePrompt',
    render: () =>
      buildOpencodePrompt({
        issue: workKeyFromIssue(962),
        specPath: '.factory/plans/issue-962.md',
        constitutionCtx: '',
        spec: '# spec',
      }),
  },
  {
    name: 'buildLocalSmallPrompt',
    render: () =>
      buildLocalSmallPrompt({
        issue: workKeyFromIssue(962),
        branch: 'ship-it/962-factory-build-prompt-carries-no',
        spec: '# spec',
      }),
  },
];

describe('factory prompt builders are self-contained', () => {
  for (const { name, render } of builders) {
    it(`${name} renders no leading slash-command token`, () => {
      const prompt = render();
      expect(prompt.startsWith('/'), `${name} produced a prompt beginning with a slash-command token`).toBe(false);
    });

    it(`${name} references no user-level skill`, () => {
      const prompt = render();
      for (const skill of SKILL_NAMES) {
        expect(prompt, `${name} references the user-level '${skill}' skill`).not.toMatch(skillReference(skill));
      }
    });
  }

  it('inlining BUILD builders send no spec frontmatter (#1595)', () => {
    const spec = '---\ndesign:\n  restatedProblem: x\nadr:\n  - title: y\n---\n# Spec: z\nbody';
    const specPath = '.factory/plans/issue-1595.md';
    const commitOnly = buildCommitOnlyPrompt({ issue: workKeyFromIssue(1595), specPath, constitutionCtx: '', spec });
    const opencode = buildOpencodePrompt({ issue: workKeyFromIssue(1595), specPath, constitutionCtx: '', spec });
    const localSmall = buildLocalSmallPrompt({ issue: workKeyFromIssue(1595), branch: 'b', spec });
    for (const prompt of [commitOnly, opencode, localSmall]) {
      expect(prompt).not.toMatch(/^adr:/m);
      expect(prompt).not.toMatch(/^design:/m);
    }
    expect(commitOnly).not.toContain(specPath);
    expect(opencode).not.toContain(specPath);
  });

  it('the claude BUILD prompt drops the ship-it reference but keeps the worktree fact', () => {
    const prompt = buildClaudePrompt({
      issue: workKeyFromIssue(962),
      branch: 'ship-it/962-factory-build-prompt-carries-no',
      specPath: '.factory/plans/issue-962.md',
      constitutionCtx: '',
    });
    expect(prompt).not.toMatch(skillReference('ship-it'));
    expect(prompt).toContain('ALREADY inside the isolated git worktree');
  });
});

describe('BUILD and rework prompts ask the worker to read the code before editing (T13)', () => {
  it('renders the read-before-edit rule once in each BUILD prompt and the rework prompt', async () => {
    const specPath = '.factory/plans/issue-962.md';
    const commitOnly = buildCommitOnlyPrompt({
      issue: workKeyFromIssue(962),
      specPath,
      constitutionCtx: '',
      spec: '# spec',
    });
    const claude = buildClaudePrompt({
      issue: workKeyFromIssue(962),
      branch: 'ship-it/962-x',
      specPath,
      constitutionCtx: '',
    });
    for (const prompt of [commitOnly, claude]) {
      expect(prompt.split(READ_BEFORE_EDIT_RULE).length).toBe(2);
      expect(prompt).toContain('read the code you will change');
    }

    const summary: CheckSummary = {
      failures: 1,
      passes: 0,
      skips: 0,
      total: 1,
      results: [{ checker: 'tests', result: 'FAIL', details: 'FAIL src/a.test.ts > adds\n  at src/a.ts:12' }],
    };
    const prompts: string[] = [];
    const router = {
      run: async (_task: string, prompt: string) => {
        prompts.push(prompt);
        return { model: 'm', output: 'ok', exitCode: 0, attempts: [] };
      },
    } as any;
    await reworkWorker({
      issue: workKeyFromIssue(962),
      worktree: '/tmp/wt',
      specPath,
      summary,
      constitution: null,
      router,
      log: () => {},
    });
    expect(prompts[0].split(REWORK_READ_RULE).length).toBe(2);
    expect(prompts[0]).toContain('read the code at each failing location');
  });
});
