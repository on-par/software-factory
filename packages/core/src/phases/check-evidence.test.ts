import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import type { CheckerContext } from '../checkers/index.js';
import type { CheckSummary, Constitution } from '../types/index.js';
import { appendEvidencePlanStep } from './check-evidence.js';
import { execGit } from '../utils/git-exec.js';

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

const tempDirs = createTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

async function fixture(plan?: unknown): Promise<{ ctx: CheckerContext; worktree: string }> {
  const worktree = await tempDirs.make('check-evidence-');
  await execGit(['init', '-q'], { cwd: worktree });
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
      async (entries, allowlist, runnerContext, lifecycle) => {
        seenLockfiles = await readdir(ctx.worktree);
        expect(entries).toHaveLength(1);
        expect(allowlist.get('test')).toEqual(['npm', 'run', 'audit']);
        expect(allowlist.get('lint')).toEqual(['pnpm', 'run', 'lint']);
        expect(runnerContext.worktree).toBe(ctx.worktree);
        expect(runnerContext.sandbox).toBe(ctx.sandbox);
        expect(runnerContext.env).toBe(ctx.env);
        expect(runnerContext.onPgid).toBe(ctx.onPgid);
        expect(runnerContext.testsTimeoutSeconds).toBe(17);
        await lifecycle?.beforeCommand();
        await lifecycle?.afterCommand('test', []);
        return [{ claim: 'build', kind: 'command', status: 'FAIL', reason: 'exited with code 1', outputTail: 'boom' }];
      },
    );
    expect(seenLockfiles).toContain('pnpm-lock.yaml');
    expect(out.results.filter((result) => result.checker === 'evidence_plan')).toHaveLength(1);
    expect(out.results.find((result) => result.checker === 'evidence_plan')?.details).toContain(
      'build [command] FAIL: exited with code 1\nboom',
    );
    expect(out.failures).toBe(1);
    expect(out.warnings).toEqual(['warning']);
  });

  it('fails weak fail-to-pass proof with structured base and head outcomes for rework', async () => {
    const { ctx } = await fixture([{ kind: 'fail-to-pass-test', claim: 'new behavior', test: 'src/new.test.ts' }]);
    const weakProof = {
      claim: 'new behavior',
      kind: 'fail-to-pass-test' as const,
      status: 'FAIL' as const,
      reason: "test doesn't exercise the change; claim new behavior; merge-base: exited 0; head: exited 0",
      baseSha: 'a'.repeat(40),
      baseRun: { exitCode: 0, timedOut: false, killed: false },
      headRun: { exitCode: 0, timedOut: false, killed: false },
    };
    const out = await appendEvidencePlanStep(summary, ctx, null, async () => [weakProof]);
    const gate = out.results.find((result) => result.checker === 'evidence_plan');
    expect(out.failures).toBe(1);
    expect(gate?.result).toBe('FAIL');
    expect(gate?.details).toContain("test doesn't exercise the change");
    expect(gate?.evidencePlanResults).toEqual([weakProof]);
  });

  it('folds leaked evidence process groups into a failed evidence_plan and keeps side_effects PASS (#3749)', async () => {
    const { ctx } = await fixture([{ kind: 'fail-to-pass-test', claim: 'new behavior', test: 'src/new.test.ts' }]);
    let killed = 0;
    ctx.processGroupTracker = {
      killAll: async () => {
        killed++;
        return [];
      },
    };
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const pgid = child.pid!;
    try {
      const out = await appendEvidencePlanStep(summary, ctx, null, async (_entries, _allowlist, _ctx, lifecycle) => {
        await lifecycle?.beforeCommand();
        await lifecycle?.afterCommand('npm run test', [pgid]);
        return [{ claim: 'new behavior', kind: 'fail-to-pass-test', status: 'FAIL', reason: 'boom' }];
      });
      const gate = out.results.find((result) => result.checker === 'evidence_plan');
      expect(gate?.result).toBe('FAIL');
      expect(gate?.details).toContain('left live process group');
      expect(gate?.details).toContain(String(pgid));
      expect(out.results.find((result) => result.checker === 'side_effects')).toMatchObject({ result: 'PASS' });
      expect(killed).toBe(1);
    } finally {
      process.kill(-pgid, 'SIGKILL');
    }
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
        { checker: 'side_effects', result: 'SKIP', details: 'disabled by constitution' },
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
      results: [
        { checker: 'lint' },
        { checker: 'evidence_plan', details: 'other checkers failed' },
        { checker: 'side_effects', details: 'other checkers failed' },
      ],
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
    expect(out.results.find((result) => result.checker === 'side_effects')).toMatchObject({
      result: 'SKIP',
      details: 'no evidencePlan in design artifact',
    });
  });

  it('side_effects skips disabled or unexecuted evidence', async () => {
    const disabledFixture = await fixture([{ kind: 'command', claim: 'proof', command: 'test', passWhen: 'passes' }]);
    const disabled: Constitution = {
      product: 'x',
      version: 1,
      checkers: [],
      body: '',
      path: '',
      source: 'bundled',
      disableEvidencePlan: true,
    };
    const disabledOutput = await appendEvidencePlanStep(summary, disabledFixture.ctx, disabled);
    expect(disabledOutput.results.find((result) => result.checker === 'side_effects')).toMatchObject({
      result: 'SKIP',
    });

    const absent = await fixture([]);
    const absentOutput = await appendEvidencePlanStep(summary, absent.ctx, null);
    expect(absentOutput.results.find((result) => result.checker === 'side_effects')).toMatchObject({ result: 'SKIP' });
  });

  it('turns command setup errors into a bounded checker failure', async () => {
    const { ctx } = await fixture([{ kind: 'command', claim: 'build', command: 'test', passWhen: 'passes' }]);
    await writeFile(join(ctx.worktree, '.factory', 'config.json'), '{');
    const out = await appendEvidencePlanStep(summary, ctx, null, async () => []);
    expect(out.results.find((result) => result.checker === 'evidence_plan')).toMatchObject({
      checker: 'evidence_plan',
      result: 'FAIL',
    });
    expect(out.results.find((result) => result.checker === 'evidence_plan')?.details.length).toBeLessThan(550);
  });
});
