// src/checkers/index.ts — Checker framework: built-in + custom checkers

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { ModelRouter } from '../router/index.js';
import type { CheckerOutput, CheckSummary, Constitution } from '../types/index.js';
import { describeCommandFailure, runCommand } from '../utils/command-runner.js';
import { extractJsonObjects } from '../utils/json.js';

interface PackageJson {
  scripts?: Record<string, string>;
  [k: string]: unknown;
}

export interface CheckerContext {
  worktree: string;
  specPath: string;
  /** Set by runAllCheckers from the resolved constitution — the single source of the standards text */
  constitutionBody?: string;
  packageJson?: PackageJson | null;
  /** Set by runAllCheckers from constitution.requireTests — missing test command becomes FAIL instead of SKIP */
  testsRequired?: boolean;
  /** Lane environment (PORT, FACTORY_APP_PORT, FACTORY_BASE_URL) merged into every checker command — set by checkPhase from the lane's port lease */
  env?: Record<string, string>;
}

export type CheckerFn = (ctx: CheckerContext) => Promise<CheckerOutput>;

// ---------- Built-in Checkers ----------

export const compileChecker: CheckerFn = async (ctx) => {
  try {
    const pkg = await getPackageJson(ctx);
    const hasBuild = pkg?.scripts?.build;

    if (hasBuild) {
      const r = await runCommand(['npm', 'run', 'build'], { cwd: ctx.worktree, timeoutMs: 120_000, env: ctx.env });
      if (r.ok) return { checker: 'compile', result: 'PASS', details: 'npm run build: OK' };
      return {
        checker: 'compile',
        result: 'FAIL',
        details: `npm run build failed: ${describeCommandFailure(r).slice(0, 500)}`,
      };
    }

    if (await fileExists(join(ctx.worktree, 'Makefile'))) {
      const r = await runCommand(['make'], { cwd: ctx.worktree, timeoutMs: 120_000, env: ctx.env });
      if (r.ok) return { checker: 'compile', result: 'PASS', details: 'make: OK' };
      return { checker: 'compile', result: 'FAIL', details: `make failed: ${describeCommandFailure(r).slice(0, 500)}` };
    }

    if (await fileExists(join(ctx.worktree, 'Cargo.toml'))) {
      const r = await runCommand(['cargo', 'build'], { cwd: ctx.worktree, timeoutMs: 120_000, env: ctx.env });
      if (r.ok) return { checker: 'compile', result: 'PASS', details: 'cargo build: OK' };
      return {
        checker: 'compile',
        result: 'FAIL',
        details: `cargo build failed: ${describeCommandFailure(r).slice(0, 500)}`,
      };
    }

    return { checker: 'compile', result: 'PASS', details: 'no build system detected — skipped' };
  } catch (e: any) {
    return {
      checker: 'compile',
      result: 'FAIL',
      details: `unexpected checker error: ${(e?.stderr || e?.message || String(e)).slice(0, 500)}`,
    };
  }
};

export const testsChecker: CheckerFn = async (ctx) => {
  try {
    if (await fileExists(join(ctx.worktree, 'scripts/verify.sh'))) {
      const r = await runCommand(['bash', 'scripts/verify.sh', '--no-e2e'], {
        cwd: ctx.worktree,
        timeoutMs: 300_000,
        env: ctx.env,
      });
      if (r.ok) return { checker: 'tests', result: 'PASS', details: 'scripts/verify.sh: OK' };
      return {
        checker: 'tests',
        result: 'FAIL',
        details: `verify.sh failed: ${describeCommandFailure(r).slice(0, 500)}`,
      };
    }

    const pkg = await getPackageJson(ctx);
    if (pkg?.scripts?.test) {
      const r = await runCommand(['npm', 'test'], { cwd: ctx.worktree, timeoutMs: 300_000, env: ctx.env });
      if (r.ok) return { checker: 'tests', result: 'PASS', details: 'npm test: OK' };
      return {
        checker: 'tests',
        result: 'FAIL',
        details: `npm test failed: ${describeCommandFailure(r).slice(0, 500)}`,
      };
    }

    if (ctx.testsRequired) {
      return {
        checker: 'tests',
        result: 'FAIL',
        details:
          'no verification command was run — constitution requires tests (requireTests: true) but the worktree has no scripts/verify.sh and no package.json test script',
      };
    }
    return {
      checker: 'tests',
      result: 'SKIP',
      details: 'no verification command was run — no scripts/verify.sh and no package.json test script found',
    };
  } catch (e: any) {
    return {
      checker: 'tests',
      result: 'FAIL',
      details: `unexpected checker error: ${(e?.stderr || e?.message || String(e)).slice(0, 500)}`,
    };
  }
};

export const lintChecker: CheckerFn = async (ctx) => {
  const details: string[] = [];
  let result: 'PASS' | 'FAIL' = 'PASS';

  const pkg = await getPackageJson(ctx);
  const scripts = pkg?.scripts ?? {};

  if (scripts.lint) {
    const r = await runCommand(['npm', 'run', 'lint'], { cwd: ctx.worktree, timeoutMs: 120_000, env: ctx.env });
    if (r.ok) {
      details.push('eslint: OK');
    } else {
      result = 'FAIL';
      details.push(`eslint failed: ${describeCommandFailure(r).slice(0, 300)}`);
    }
  }

  // TypeScript type check
  if (await fileExists(join(ctx.worktree, 'tsconfig.json'))) {
    const r = await runCommand(['npx', 'tsc', '--noEmit'], { cwd: ctx.worktree, timeoutMs: 120_000, env: ctx.env });
    if (r.ok) {
      details.push('tsc: OK');
    } else {
      result = 'FAIL';
      details.push(`tsc failed: ${describeCommandFailure(r).slice(0, 300)}`);
    }
  }

  if (details.length === 0) {
    details.push('no linting configured — skipped');
  }

  return { checker: 'lint', result, details: details.join('; ') };
};

export const linksChecker: CheckerFn = async (ctx) => {
  const files = await findHtmlFiles(ctx.worktree);

  if (files.length === 0) {
    return { checker: 'links', result: 'PASS', details: 'no HTML files — skipped' };
  }

  const urls = new Set<string>();
  let broken = 0;

  for (const rel of files) {
    const html = await readFile(join(ctx.worktree, rel), 'utf-8').catch(() => '');

    for (const match of html.matchAll(/(?:href|src)=["']([^"'#]*)/g)) {
      const url = match[1];
      if (!url || /^(mailto:|tel:|javascript:|data:)/.test(url)) continue;
      urls.add(url);
    }

    broken += html.split(/\r?\n/).filter((l) => l.includes('href="#"')).length;
  }

  const checked = urls.size;

  return {
    checker: 'links',
    result: broken > 0 ? 'FAIL' : 'PASS',
    details: broken > 0 ? `${broken} placeholder href="#" links found` : `checked ${checked} links, all OK`,
    linksChecked: checked,
    broken,
  };
};

const MAX_ACCESSIBILITY_FILES = 20;

export const accessibilityChecker: CheckerFn = async (ctx) => {
  const allFiles = await findHtmlFiles(ctx.worktree);

  if (allFiles.length === 0) {
    return { checker: 'accessibility', result: 'PASS', details: 'no HTML files — skipped' };
  }

  const files = allFiles.slice(0, MAX_ACCESSIBILITY_FILES);
  const unscanned = allFiles.length - files.length;

  let issues = 0;
  const details: string[] = [];

  for (const rel of files) {
    const html = await readFile(join(ctx.worktree, rel), 'utf-8').catch(() => '');

    // Images without alt
    const imgNoAlt = (html.match(/<img[^>]*>/g) ?? []).filter((t) => !t.includes('alt=')).length;
    if (imgNoAlt > 0) {
      issues += imgNoAlt;
      details.push(`${rel}: ${imgNoAlt} images without alt`);
    }

    // Placeholder links
    const ph = html.split(/\r?\n/).filter((l) => l.includes('href="#"')).length;
    if (ph > 0) {
      issues += ph;
      details.push(`${rel}: ${ph} placeholder links`);
    }
  }

  const coverage =
    unscanned > 0
      ? `scanned first ${files.length} of ${allFiles.length} HTML files (${unscanned} not scanned)`
      : `scanned ${files.length} HTML files`;

  return {
    checker: 'accessibility',
    result: issues > 0 ? 'FAIL' : 'PASS',
    details:
      details.length > 0
        ? `${coverage}; ${details.join('; ')} (note: browser-based axe-core recommended for full WCAG)`
        : `basic checks passed (alt, placeholder links) — ${coverage}`,
  };
};

// ---------- Custom Checker (agent-based) ----------

/** Trust boundary: LLM checker output is unvalidated JSON — accept only an exact-shape verdict. */
function isCustomCheckerVerdict(
  value: unknown,
  checkerName: string,
): value is { checker: string; result: 'PASS' | 'FAIL'; details: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.checker === checkerName && (v.result === 'PASS' || v.result === 'FAIL') && typeof v.details === 'string';
}

export async function runCustomChecker(
  ctx: CheckerContext,
  checkerName: string,
  router: ModelRouter,
  timeoutSeconds?: number,
): Promise<CheckerOutput> {
  const prompt = `You are a CHECKER agent for a software factory. Your job is to independently
verify the work in the worktree against a specific standard. Do NOT trust the worker's
self-report — verify directly.

WORKTREE: ${ctx.worktree}
CHECKER NAME: ${checkerName}
SPEC: ${await readFile(ctx.specPath, 'utf-8').catch(() => '(no spec)')}

CONSTITUTION (the written standard):
${ctx.constitutionBody ?? '(none)'}

Your job: Run the '${checkerName}' check. This is a custom checker defined in the
constitution above. Find the relevant standard in the constitution and verify the
work in the worktree against it.

Steps:
1. Read the constitution to understand what '${checkerName}' should verify.
2. Inspect the worktree files relevant to this check.
3. Run any necessary commands (lint, build, test, grep, etc.) to verify.
4. Return a JSON verdict on stdout (and ONLY the JSON):
{"checker":"${checkerName}","result":"PASS or FAIL","details":"<specific findings>"}`;

  try {
    const result = await router.run('check_custom', prompt, {
      worktree: ctx.worktree,
      timeoutSeconds: timeoutSeconds ?? 1800,
      env: ctx.env,
    });
    // Extract the verdict: first balanced JSON object that carries a "checker" key
    const candidates = extractJsonObjects(result.output);
    const verdictCandidate = candidates.find(
      (c) =>
        typeof c.value === 'object' &&
        c.value !== null &&
        !Array.isArray(c.value) &&
        'checker' in (c.value as Record<string, unknown>),
    );
    if (verdictCandidate) {
      if (isCustomCheckerVerdict(verdictCandidate.value, checkerName)) {
        return { checker: checkerName, result: verdictCandidate.value.result, details: verdictCandidate.value.details };
      }
      return {
        checker: checkerName,
        result: 'FAIL',
        details: `checker returned a malformed verdict: ${verdictCandidate.text.slice(0, 200)}`,
      };
    }
    return {
      checker: checkerName,
      result: 'FAIL',
      details: `checker produced no valid JSON: ${result.output.slice(0, 200)}`,
    };
  } catch (e: any) {
    return {
      checker: checkerName,
      result: 'FAIL',
      details: `checker agent failed: ${(e?.stderr || e?.message || String(e)).slice(0, 300)}`,
    };
  }
}

// ---------- Runner: run all checkers for a product ----------

const BUILT_IN_CHECKERS: Record<string, CheckerFn> = {
  compile: compileChecker,
  tests: testsChecker,
  lint: lintChecker,
  links: linksChecker,
  accessibility: accessibilityChecker,
};

export async function runAllCheckers(
  ctx: CheckerContext,
  router: ModelRouter,
  constitution: Constitution | null,
  customCheckerTimeoutSeconds?: number,
): Promise<CheckSummary> {
  const results: CheckerOutput[] = [];
  const standardNames = Object.keys(BUILT_IN_CHECKERS);
  const productCheckers = constitution?.checkers ?? [];

  const allCheckers = [...standardNames, ...productCheckers.filter((c) => !standardNames.includes(c))];
  let packageJson: PackageJson | null | undefined;
  try {
    packageJson = await loadPackageJson(ctx.worktree);
  } catch {
    packageJson = undefined; // let each checker surface the read error through its own error handling
  }
  // the constitution is the single source of truth for the standards body —
  // custom checkers must be graded against the same text that declared them
  const sharedCtx: CheckerContext = {
    ...ctx,
    packageJson,
    constitutionBody: constitution?.body ?? '',
    testsRequired: constitution?.requireTests === true,
  };

  for (const name of allCheckers) {
    let output: CheckerOutput;

    if (BUILT_IN_CHECKERS[name]) {
      try {
        output = await BUILT_IN_CHECKERS[name](sharedCtx);
      } catch (e: any) {
        // Fail closed: a checker that crashes must not vanish from the summary
        output = {
          checker: name,
          result: 'FAIL',
          details: `checker crashed: ${(e?.message ?? String(e)).slice(0, 500)}`,
        };
      }
    } else if (name.startsWith('custom_')) {
      output = await runCustomChecker(sharedCtx, name, router, customCheckerTimeoutSeconds);
    } else {
      // Fail closed: a declared standard we can't run must not vanish from the summary
      output = {
        checker: name,
        result: 'FAIL',
        details: `unknown checker '${name}' — not a built-in (${standardNames.join(', ')}) and not a custom_* agent checker; failing closed so the declared standard is not silently skipped`,
      };
    }

    results.push(output);
  }

  const failures = results.filter((r) => r.result === 'FAIL').length;
  const passes = results.filter((r) => r.result === 'PASS').length;
  const skips = results.filter((r) => r.result === 'SKIP').length;

  return {
    failures,
    passes,
    skips,
    total: results.length,
    results,
  };
}

// ---------- Helpers ----------

async function loadPackageJson(worktree: string): Promise<PackageJson | null> {
  let raw: string;
  try {
    raw = await readFile(join(worktree, 'package.json'), 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null; // no package.json is a legitimate skip, not an error
    throw e;
  }
  return JSON.parse(raw) as PackageJson;
}

async function getPackageJson(ctx: CheckerContext): Promise<PackageJson | null> {
  return ctx.packageJson !== undefined ? ctx.packageJson : loadPackageJson(ctx.worktree);
}

// Generated output, not product source — scanning these produces false
// positives (e.g. a coverage HTML report embeds source text like `href="#"`
// literals from the checkers themselves as syntax-highlighted code, not markup).
const GENERATED_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.next', 'out']);

async function findHtmlFiles(worktree: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (GENERATED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        results.push(relative(worktree, join(dir, entry.name)));
      }
    }
  }

  await walk(worktree);
  results.sort();
  return results;
}

/** True when the path exists and is a regular file — directories and missing paths return false. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
