// Factory prompts are self-contained: a rendered prompt references only its own text and repo
// files it names by path — never a leading slash-command token or a user-level Claude Code
// skill. Constitutions (#721) are the per-repo extension point; skills are not.

import { describe, expect, it } from 'vitest';

import { buildClaudePrompt, buildCommitOnlyPrompt, buildLocalSmallPrompt, buildOpencodePrompt } from './build.js';
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
        issue: 962,
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
        issue: 962,
        branch: 'ship-it/962-factory-build-prompt-carries-no',
        specPath: '.factory/plans/issue-962.md',
        constitutionCtx: '',
      }),
  },
  {
    name: 'buildCommitOnlyPrompt',
    render: () =>
      buildCommitOnlyPrompt({
        issue: 962,
        specPath: '.factory/plans/issue-962.md',
        constitutionCtx: '',
        spec: '# spec',
      }),
  },
  {
    name: 'buildOpencodePrompt',
    render: () =>
      buildOpencodePrompt({
        issue: 962,
        specPath: '.factory/plans/issue-962.md',
        constitutionCtx: '',
        spec: '# spec',
      }),
  },
  {
    name: 'buildLocalSmallPrompt',
    render: () =>
      buildLocalSmallPrompt({ issue: 962, branch: 'ship-it/962-factory-build-prompt-carries-no', spec: '# spec' }),
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

  it('the claude BUILD prompt drops the ship-it reference but keeps the worktree fact', () => {
    const prompt = buildClaudePrompt({
      issue: 962,
      branch: 'ship-it/962-factory-build-prompt-carries-no',
      specPath: '.factory/plans/issue-962.md',
      constitutionCtx: '',
    });
    expect(prompt).not.toMatch(skillReference('ship-it'));
    expect(prompt).toContain('ALREADY inside the isolated git worktree');
  });
});
