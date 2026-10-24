import { describe, expect, it } from 'vitest';

import { ENV_ERROR_PREFIX, VERIFY_SANDBOX_ENV_MARKER } from '../environment/sandbox-env.js';
import { buildClaudePrompt, buildCommitOnlyPrompt } from './build-prompts.js';

const PWSH = 'pwsh -NoProfile -NonInteractive -File scripts/verify.ps1';
const base = { issue: 1, specPath: 'spec.md', constitutionCtx: 'ctx', spec: 'spec' };
const claudeBase = { issue: 1, branch: 'b', specPath: 'spec.md', constitutionCtx: 'ctx' };

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
