import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CheckerContext } from '../checkers/index.js';
import type { CheckSummary, Constitution } from '../types/index.js';
import { appendEvidencePlanStep } from './check-evidence.js';

const artifact = {
  restatedProblem: 'A proof is needed.',
  approach: { chosen: 'Run the plan.', rejected: [] },
  interfacesTouched: [],
  targetTypes: [],
  signatures: [],
  callGraph: [],
  behaviorContract: ['Proofs run after ordinary checks.'],
  verificationPlan: [{ command: 'npm test', passWhen: 'passes' }],
  riskBlastRadius: 'CHECK behavior.',
  openQuestions: [],
};

const summary: CheckSummary = {
  failures: 0,
  passes: 1,
  skips: 0,
  total: 1,
  results: [{ checker: 'compile', result: 'PASS', details: 'ok' }],
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(plan?: unknown): Promise<{ ctx: CheckerContext; worktree: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-evidence-'));
  tempDirs.push(worktree);
  const specPath = join(worktree, 'issue.md');
  await writeFile(specPath, `---\ndesign: ${JSON.stringify({ ...artifact, evidencePlan: plan })}\n---\nSpec\n`);
  await writeFile(
    join(worktree, 'package.json'),
    JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }),
  );
  await writeFile(join(worktree, 'pnpm-lock.yaml'), '');
  await mkdir(join(worktree, '.factory'));
  await writeFile(
    join(worktree, '.factory', 'config.json'),
    JSON.stringify({ version: 2, commands: { test: 'npm run audit' } }),
  );
  const entries = await readdir(worktree);
  expect(entries).toContain('pnpm-lock.yaml');
  return {
    worktree,
    ctx: {
      worktree,
      specPath,
      probe: {
        packageJson: { status: 'loaded', value: { scripts: { test: 'vitest run', lint: 'eslint .' } } },
        htmlFiles: [],
        playwrightConfigFiles: [],
        playwrightConfigContents: {},
        scripts: {},
        pythonTestSurface: { present: false, sources: [] },
        lintConfig: null,
      },
    },
  };
}

describe('appendEvidencePlanStep', () => {
  it('runs eligible entries and preserves summary metadata while replacing prior outcomes', async () => {
    const { ctx } = await fixture([{ kind: 'command', claim: 'build', command: 'test', passWhen: 'passes' }]);
    ctx.env = { PORT: '3100', FACTORY_BASE_URL: 'http://127.0.0.1:3100' };
    ctx.onPgid = (pgid) => expect(pgid).toBe(42);
    ctx.testsTimeoutSeconds = 17;
    let seenLockfiles: string[] = [];
    const out = await appendEvidencePlanStep(
      {
        ...summary,
        warnings: ['warning'],
        results: [...summary.results, { checker: 'evidence_plan', result: 'FAIL', details: 'stale' }],
      },
      ctx,
      null,
      async (entries, allowlist, runnerContext) => {
        seenLockfiles = await readdir(ctx.worktree);
        expect(entries).toHaveLength(1);
        expect(allowlist.get('test')).toEqual(['npm', 'run', 'audit']);
        expect(allowlist.get('lint')).toEqual(['pnpm', 'run', 'lint']);
        expect(runnerContext.worktree).toBe(ctx.worktree);
        expect(runnerContext.sandbox).toBe(ctx.sandbox);
        expect(runnerContext.env).toBe(ctx.env);
        expect(runnerContext.onPgid).toBe(ctx.onPgid);
        expect(runnerContext.testsTimeoutSeconds).toBe(17);
        return [{ claim: 'build', kind: 'command', status: 'FAIL', reason: 'exited with code 1', outputTail: 'boom' }];
      },
    );
    expect(seenLockfiles).toContain('pnpm-lock.yaml');
    expect(out.results.filter((result) => result.checker === 'evidence_plan')).toHaveLength(1);
    expect(out.results.at(-1)?.details).toContain('build [command] FAIL: exited with code 1\nboom');
    expect(out.failures).toBe(1);
    expect(out.warnings).toEqual(['warning']);
  });

  it('skips disabled and blocked gates without calling the runner', async () => {
    const { ctx } = await fixture([{ kind: 'none', claim: 'docs', reason: 'docs' }]);
    const runEvidence = async () => {
      throw new Error('must not run');
    };
    const disabled: Constitution = {
      product: 'x',
      version: 1,
      checkers: [],
      body: '',
      path: '',
      source: 'bundled',
      disableEvidencePlan: true,
    };
    await expect(appendEvidencePlanStep(summary, ctx, disabled, runEvidence)).resolves.toMatchObject({
      results: [
        ...summary.results,
        { checker: 'evidence_plan', result: 'SKIP', details: 'disabled by constitution', evidencePlanResults: [] },
      ],
    });
    await expect(
      appendEvidencePlanStep(
        {
          ...summary,
          failures: 2,
          results: [
            { checker: 'lint', result: 'FAIL', details: 'red' },
            { checker: 'evidence_plan', result: 'FAIL', details: 'stale evidence failure' },
          ],
        },
        ctx,
        null,
        runEvidence,
      ),
    ).resolves.toMatchObject({
      results: [{ checker: 'lint' }, { checker: 'evidence_plan', details: 'other checkers failed' }],
    });
  });

  it('records an empty or absent plan as a non-failing skip', async () => {
    const { ctx } = await fixture([]);
    let calls = 0;
    const out = await appendEvidencePlanStep(summary, ctx, null, async () => {
      calls++;
      return [];
    });
    expect(calls).toBe(0);
    expect(out.results.at(-1)).toMatchObject({ result: 'SKIP', details: 'no evidencePlan in design artifact' });
  });

  it('turns command setup errors into a bounded checker failure', async () => {
    const { ctx } = await fixture([{ kind: 'command', claim: 'build', command: 'test', passWhen: 'passes' }]);
    await writeFile(join(ctx.worktree, '.factory', 'config.json'), '{');
    const out = await appendEvidencePlanStep(summary, ctx, null, async () => []);
    expect(out.results.at(-1)).toMatchObject({ checker: 'evidence_plan', result: 'FAIL' });
    expect(out.results.at(-1)?.details.length).toBeLessThan(550);
  });
});
