import { describe, expect, it } from 'vitest';

import type { CheckSummary } from '../types/index.js';
import { reworkWorker } from './check.js';

describe('reworkWorker extraInstructions (#2816)', () => {
  const summary: CheckSummary = {
    failures: 1,
    passes: 0,
    skips: 0,
    total: 1,
    results: [{ checker: 'ci_codeql', result: 'FAIL', details: 'js/xss at a.ts:3 — bad' }],
  };

  async function promptFor(extraInstructions?: string): Promise<string> {
    const prompts: string[] = [];
    const router = {
      run: async (_task: string, prompt: string) => {
        prompts.push(prompt);
        return { model: 'm', output: 'ok', exitCode: 0, attempts: [] };
      },
    } as any;
    await reworkWorker({
      issue: 1,
      worktree: '/tmp/wt',
      specPath: '/tmp/spec.md',
      summary,
      constitution: null,
      router,
      log: () => {},
      ...(extraInstructions ? { extraInstructions } : {}),
    });
    return prompts[0];
  }

  it('adds extraInstructions as step 5', async () => {
    const prompt = await promptFor('Suppression is forbidden.');
    expect(prompt).toContain('### ci_codeql\njs/xss at a.ts:3 — bad');
    expect(prompt).toContain('4. Commit the repair with a clear message.\n5. Suppression is forbidden.\n\nDo not push');
  });

  it('leaves the prompt without suppression text when absent', async () => {
    const prompt = await promptFor();
    expect(prompt).not.toMatch(/suppress/i);
    expect(prompt).not.toContain('5. ');
  });
});
