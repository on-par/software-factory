import { workKeyFromIssue } from '../work/work-key.js';
import { describe, expect, it } from 'vitest';

import { ENV_ERROR_PREFIX, VERIFY_SANDBOX_ENV_MARKER } from '../environment/sandbox-env.js';
import {
  buildClaudePrompt,
  buildCommitOnlyPrompt,
  buildLocalSmallPrompt,
  buildOpencodePrompt,
} from './build-prompts.js';

const PWSH = 'pwsh -NoProfile -NonInteractive -File scripts/verify.ps1';
const base = { issue: workKeyFromIssue(1), specPath: 'spec.md', constitutionCtx: 'ctx', spec: 'spec' };
const claudeBase = { issue: workKeyFromIssue(1), branch: 'b', specPath: 'spec.md', constitutionCtx: 'ctx' };

describe('verify rule', () => {
  it('verify rule names the pwsh command when verifyCommand is set', () => {
    for (const prompt of [
      buildCommitOnlyPrompt({ ...base, verifyCommand: PWSH }),
      buildClaudePrompt({ ...claudeBase, verifyCommand: PWSH }),
    ]) {
      expect(prompt).toContain(PWSH);
      expect(prompt).not.toContain('npm test');
      expect(prompt).not.toContain('pytest');
    }
  });

  it('verify rule keeps the verify.sh / npm / pytest base when verifyCommand is unset', () => {
    expect(buildCommitOnlyPrompt(base)).toContain('bash scripts/verify.sh --no-e2e');
    expect(buildClaudePrompt(claudeBase)).toContain('bash scripts/verify.sh --no-e2e');
  });

  it('tells the worker to stop with an ENV-ERROR line on the sandbox marker (#3332)', () => {
    for (const prompt of [buildCommitOnlyPrompt(base), buildClaudePrompt(claudeBase)]) {
      expect(prompt).toContain(VERIFY_SANDBOX_ENV_MARKER);
      expect(prompt).toContain(ENV_ERROR_PREFIX);
    }
  });
});

describe('verify rule with tests.affected (#3260)', () => {
  const affectedTestsCommand = 'npx vitest related --run {files}';

  it('names the affected template and says CHECK runs the full suite before SHIP', () => {
    for (const prompt of [
      buildCommitOnlyPrompt({ ...base, affectedTestsCommand }),
      buildClaudePrompt({ ...claudeBase, affectedTestsCommand }),
    ]) {
      expect(prompt).toContain(`\`${affectedTestsCommand}\``);
      expect(prompt).toContain('CHECK runs the full suite before SHIP');
    }
  });

  it('is byte-identical to the default prompt when unset', () => {
    expect(buildCommitOnlyPrompt({ ...base, affectedTestsCommand: undefined })).toBe(buildCommitOnlyPrompt(base));
    expect(buildCommitOnlyPrompt(base)).not.toContain('affected tests');
  });
});

describe('BUILD prompts inline the parsed spec body once (#1595)', () => {
  const spec = [
    '---',
    'route: codex',
    'design:',
    '  restatedProblem: DESIGN-FM-MARKER',
    'adr:',
    '  - title: ADR-DRAFT-MARKER',
    '---',
    '# Spec: x',
    'BODY-MARKER',
  ].join('\n');
  const specPath = '.factory/plans/issue-1595.md';
  const designGrounding = '## Design grounding (from the frozen PLAN artifact)\nGROUNDING-MARKER';
  const opts = { issue: workKeyFromIssue(1595), specPath, constitutionCtx: '', spec, designGrounding };

  function expectBodyOnce(prompt: string): void {
    expect(prompt.split('BODY-MARKER')).toHaveLength(2);
    expect(prompt.split('GROUNDING-MARKER')).toHaveLength(2);
    expect(prompt).not.toMatch(/^adr:/m);
    expect(prompt).not.toContain('ADR-DRAFT-MARKER');
    expect(prompt).not.toContain('DESIGN-FM-MARKER');
    expect(prompt).not.toContain('route: codex');
    expect(prompt).not.toMatch(/^---$/m);
    expect(prompt).not.toContain(specPath);
    expect(prompt).not.toContain('also saved at');
  }

  it('commit-only prompt carries body and grounding once', () => {
    expectBodyOnce(buildCommitOnlyPrompt(opts));
  });

  it('opencode prompt carries body and grounding once', () => {
    expectBodyOnce(buildOpencodePrompt(opts));
  });

  it('local-small prompt inlines the frontmatter-free body', () => {
    const prompt = buildLocalSmallPrompt({ issue: workKeyFromIssue(1595), branch: 'b', spec });
    expect(prompt).toContain('BODY-MARKER');
    expect(prompt).not.toMatch(/^adr:/m);
    expect(prompt).not.toContain('DESIGN-FM-MARKER');
  });

  it('a spec without frontmatter is still inlined once', () => {
    const prompt = buildCommitOnlyPrompt({
      issue: workKeyFromIssue(1595),
      specPath,
      constitutionCtx: '',
      spec: '# spec-NOFM',
    });
    expect(prompt.split('# spec-NOFM')).toHaveLength(2);
  });
});
