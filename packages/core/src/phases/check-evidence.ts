import { readdir } from 'node:fs/promises';

import type { EvidencePlanEntry } from '@on-par/contracts';
import { loadRepoConfig } from '../config/repo.js';
import { parseDesignArtifact } from '../design/index.js';
import { resolveEvidenceAllowlist } from '../checkers/evidence-allowlist.js';
import { runEvidencePlan, type EvidencePlanResult } from '../checkers/evidence-plan.js';
import { createEvidenceSideEffectsGuard } from '../checkers/side-effects.js';
import { summarizeCheckerOutputs, type CheckerContext } from '../checkers/index.js';
import type { CheckSummary, CheckerOutput, Constitution } from '../types/index.js';
import { readSpec } from '../spec/index.js';

const MAX_ERROR_LENGTH = 500;

function gateOutput(result: CheckerOutput, sideEffects: CheckerOutput, summary: CheckSummary): CheckSummary {
  const results = [
    ...summary.results.filter((item) => !['evidence_plan', 'side_effects'].includes(item.checker)),
    result,
    sideEffects,
  ];
  const counts = summarizeCheckerOutputs(results);
  return { ...summary, ...counts };
}

function outputForResults(results: EvidencePlanResult[]): CheckerOutput {
  const failed = results.filter((entry) => entry.status === 'FAIL');
  const passed = results.some((entry) => entry.status === 'PASS');
  const status = failed.length > 0 ? 'FAIL' : passed ? 'PASS' : 'SKIP';
  const details = results
    .map((entry) => {
      const line = `${entry.claim} [${entry.kind}] ${entry.status}: ${entry.reason}`;
      return entry.status === 'FAIL' && entry.outputTail ? `${line}\n${entry.outputTail}` : line;
    })
    .join('\n');
  return {
    checker: 'evidence_plan',
    result: status,
    details: details || 'no evidencePlan in design artifact',
    evidencePlanResults: results,
  };
}

function skip(reason: string): CheckerOutput {
  return { checker: 'evidence_plan', result: 'SKIP', details: reason, evidencePlanResults: [] };
}

function skipSideEffects(reason: string): CheckerOutput {
  return { checker: 'side_effects', result: 'SKIP', details: reason };
}

function packageJsonFromContext(ctx: CheckerContext): unknown {
  const pkg = ctx.probe?.packageJson;
  if (!pkg) return null;
  return pkg.status === 'loaded' ? pkg.value : null;
}

async function touchActivity(ctx: CheckerContext): Promise<void> {
  try {
    await ctx.onActivity?.();
  } catch (error) {
    ctx.log?.(
      'activity_touch_failed',
      `activity snapshot touch failed: ${(error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH)}`,
    );
  }
}

/** Append or refresh the phase-owned frozen evidence-plan gate in a CHECK summary. */
export async function appendEvidencePlanStep(
  summary: CheckSummary,
  ctx: CheckerContext,
  constitution: Constitution | null,
  runEvidence: typeof runEvidencePlan = runEvidencePlan,
): Promise<CheckSummary> {
  const ordinary = summary.results.filter((item) => !['evidence_plan', 'side_effects'].includes(item.checker));
  const startedAt = Date.now();
  await touchActivity(ctx);
  ctx.log?.('checker_started', 'checker evidence_plan started');
  await touchActivity(ctx);
  ctx.log?.('checker_started', 'checker side_effects started');

  let output: CheckerOutput;
  let sideEffectsOutput: CheckerOutput = skipSideEffects('no evidence command executed');
  if (constitution?.disableEvidencePlan === true) {
    output = skip('disabled by constitution');
    sideEffectsOutput = skipSideEffects('disabled by constitution');
  } else if (ordinary.some((item) => item.result === 'FAIL')) {
    output = skip('other checkers failed');
    sideEffectsOutput = skipSideEffects('other checkers failed');
  } else {
    let entries: EvidencePlanEntry[] | undefined;
    try {
      const spec = await readSpec(ctx.specPath);
      const parsed = parseDesignArtifact(spec.data);
      if (parsed.errors.length > 0) ctx.log?.('check', `evidence plan design artifact: ${parsed.errors.join('; ')}`);
      entries = parsed.artifact?.evidencePlan;
    } catch (error) {
      ctx.log?.(
        'check',
        `evidence plan spec unavailable: ${(error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH)}`,
      );
    }
    if (!entries?.length) {
      output = skip('no evidencePlan in design artifact');
      sideEffectsOutput = skipSideEffects('no evidencePlan in design artifact');
    } else {
      let guard: ReturnType<typeof createEvidenceSideEffectsGuard> | undefined;
      try {
        const repoConfig = loadRepoConfig(ctx.worktree);
        const lockfiles = await readdir(ctx.worktree);
        const allowlist = resolveEvidenceAllowlist(packageJsonFromContext(ctx), repoConfig, lockfiles);
        guard = createEvidenceSideEffectsGuard(ctx);
        const results = await runEvidence(entries, allowlist, ctx, guard);
        output = outputForResults(results);
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(-MAX_ERROR_LENGTH);
        output = {
          checker: 'evidence_plan',
          result: 'FAIL',
          details: `evidence plan setup failed: ${message}`,
          evidencePlanResults: [],
        };
      }
      if (guard) {
        const evidenceFailed = output.result === 'FAIL';
        sideEffectsOutput = await guard.finish({ evidenceFailed });
        const leaks = evidenceFailed ? guard.leakReport() : [];
        if (leaks.length) output = { ...output, details: [output.details, ...leaks].join('\n') };
      } else sideEffectsOutput = skipSideEffects('evidence plan setup failed before execution');
    }
  }

  ctx.log?.('checker_completed', `checker evidence_plan completed (${output.result})`, {
    durationMs: Date.now() - startedAt,
  });
  ctx.log?.('checker_completed', `checker side_effects completed (${sideEffectsOutput.result})`, {
    durationMs: Date.now() - startedAt,
  });
  await touchActivity(ctx);
  await touchActivity(ctx);
  return gateOutput(output, sideEffectsOutput, { ...summary, results: ordinary });
}
