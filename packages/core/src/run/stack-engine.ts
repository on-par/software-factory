// packages/core/src/run/stack-engine.ts — the one stack engine for run-brief and run-issue --stack (#3798)

/** What a slice run reports; a failed slice throws instead. */
export interface SliceOutcome {
  prNumber?: number;
  branch?: string;
}

export interface StackSlice {
  title: string;
  run: (base: string | undefined) => Promise<SliceOutcome | undefined>;
}

export type StackPlan = readonly StackSlice[];

export type StackLogLevel = 'info' | 'warn' | 'error';

export interface StackSliceResult {
  title: string;
  status: 'ready' | 'failed' | 'skipped';
  prNumber?: number;
  /** The base the slice ran on; only set when chaining. */
  base?: string;
  detail?: string;
}

export interface StackRunOptions {
  /** Base of the first slice (and of every slice when chain is false). */
  base?: string;
  /** true: slice k+1 bases on slice k's PR head and the stack stops at the first failure or missing PR. */
  chain: boolean;
  /** Log prefix, e.g. 'run-brief'. */
  prefix: string;
  /** Singular noun for the summary, e.g. 'brief' → "Briefs:" and "2/3 briefs succeeded". */
  noun: string;
  log: (level: StackLogLevel, line: string) => void;
}

export interface StackRunResult {
  ok: boolean;
  results: StackSliceResult[];
  summary: string[];
}

/** The base the next stacked slice starts from: this slice's PR head branch, or why the stack stops. */
function nextStackBase(outcome: SliceOutcome | undefined): { base: string } | { stop: string } {
  if (outcome && outcome.prNumber !== undefined && outcome.branch) return { base: outcome.branch };
  return { stop: 'opened no PR' };
}

function formatSummary(results: readonly StackSliceResult[], noun: string): string[] {
  const lines = [`${noun.charAt(0).toUpperCase()}${noun.slice(1)}s:`];
  for (const r of results) {
    if (r.status === 'ready') {
      const base = r.base !== undefined ? ` (base ${r.base})` : '';
      lines.push(r.prNumber !== undefined ? `  ${r.title} → PR #${r.prNumber}${base}` : `  ${r.title} → done (no PR)`);
    } else if (r.status === 'skipped') {
      lines.push(`  ${r.title} → skipped: ${r.detail}`);
    } else {
      lines.push(r.detail ? `  ${r.title} → failed: ${r.detail}` : `  ${r.title} → failed`);
    }
  }
  const done = results.filter((r) => r.status === 'ready').length;
  lines.push(`${done}/${results.length} ${noun}s succeeded`);
  return lines;
}

/** Runs the slices in order. When chaining, each slice bases on the previous slice's PR head and the
 *  stack stops at the first failure or missing PR, marking the rest skipped. */
export async function runStack(plan: StackPlan, opts: StackRunOptions): Promise<StackRunResult> {
  const { chain, prefix, noun, log } = opts;
  const n = plan.length;
  let base = opts.base;
  let stop: string | undefined;
  const results: StackSliceResult[] = [];
  for (const [i, slice] of plan.entries()) {
    const { title } = slice;
    if (stop !== undefined) {
      log('warn', `${prefix}: [${i + 1}/${n}] ${title} skipped: ${stop}`);
      results.push({ title, status: 'skipped', detail: stop });
      continue;
    }
    log('info', `${prefix}: [${i + 1}/${n}] ${title}`);
    if (chain && base !== undefined) log('info', `${prefix}: [${i + 1}/${n}] stacking on ${base}`);
    try {
      const outcome = await slice.run(base);
      results.push({ title, status: 'ready', prNumber: outcome?.prNumber, ...(chain ? { base } : {}) });
      if (chain) {
        const next = nextStackBase(outcome);
        if ('base' in next) base = next.base;
        else stop = `stack stopped: ${title} ${next.stop}`;
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log('error', detail);
      results.push({ title, status: 'failed', detail });
      if (chain) stop = `stack stopped: ${title} failed`;
    }
  }
  return {
    ok: results.every((r) => r.status === 'ready'),
    results,
    summary: formatSummary(results, noun),
  };
}
