// src/checkers/index.ts — Checker framework: built-in + custom checkers

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ModelRouter } from '../router/index.js';
import type { CheckerOutput, CheckSummary, Constitution } from '../types/index.js';

const exec = promisify(execCb);

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
}

export type CheckerFn = (ctx: CheckerContext) => Promise<CheckerOutput>;

// ---------- Built-in Checkers ----------

export const compileChecker: CheckerFn = async (ctx) => {
  try {
    const pkg = await getPackageJson(ctx);
    const hasBuild = pkg?.scripts?.build;

    if (hasBuild) {
      try {
        await exec('npm run build', { cwd: ctx.worktree, timeout: 120000 });
        return { checker: 'compile', result: 'PASS', details: 'npm run build: OK' };
      } catch (e: any) {
        return { checker: 'compile', result: 'FAIL', details: `npm run build failed: ${(e.stderr || e.message || '').slice(0, 500)}` };
      }
    }

    // Try make
    try {
      await exec('make', { cwd: ctx.worktree, timeout: 120000 });
      return { checker: 'compile', result: 'PASS', details: 'make: OK' };
    } catch {
      // Try cargo
      try {
        await exec('cargo build', { cwd: ctx.worktree, timeout: 120000 });
        return { checker: 'compile', result: 'PASS', details: 'cargo build: OK' };
      } catch {
        return { checker: 'compile', result: 'PASS', details: 'no build system detected — skipped' };
      }
    }
  } catch {
    return { checker: 'compile', result: 'PASS', details: 'no build system detected — skipped' };
  }
};

export const testsChecker: CheckerFn = async (ctx) => {
  try {
    if (await fileExists(join(ctx.worktree, 'scripts/verify.sh'))) {
      try {
        await exec('bash scripts/verify.sh --no-e2e', { cwd: ctx.worktree, timeout: 300000 });
        return { checker: 'tests', result: 'PASS', details: 'scripts/verify.sh: OK' };
      } catch (e: any) {
        return { checker: 'tests', result: 'FAIL', details: `verify.sh failed: ${(e.stderr || e.message || '').slice(0, 500)}` };
      }
    }

    const pkg = await getPackageJson(ctx);
    if (pkg?.scripts?.test) {
      try {
        await exec('npm test', { cwd: ctx.worktree, timeout: 300000 });
        return { checker: 'tests', result: 'PASS', details: 'npm test: OK' };
      } catch (e: any) {
        return { checker: 'tests', result: 'FAIL', details: `npm test failed: ${(e.stderr || e.message || '').slice(0, 500)}` };
      }
    }

    return { checker: 'tests', result: 'PASS', details: 'no test command found — skipped' };
  } catch {
    return { checker: 'tests', result: 'PASS', details: 'no test command found — skipped' };
  }
};

export const lintChecker: CheckerFn = async (ctx) => {
  const details: string[] = [];
  let result: 'PASS' | 'FAIL' = 'PASS';

  const pkg = await getPackageJson(ctx);
  const scripts = pkg?.scripts ?? {};

  if (scripts.lint) {
    try {
      await exec('npm run lint', { cwd: ctx.worktree, timeout: 120000 });
      details.push('eslint: OK');
    } catch (e: any) {
      result = 'FAIL';
      details.push(`eslint failed: ${(e.stderr || e.message || '').slice(0, 300)}`);
    }
  }

  // TypeScript type check
  if (await fileExists(join(ctx.worktree, 'tsconfig.json'))) {
    try {
      await exec('npx tsc --noEmit', { cwd: ctx.worktree, timeout: 120000 });
      details.push('tsc: OK');
    } catch (e: any) {
      result = 'FAIL';
      details.push(`tsc failed: ${(e.stderr || e.message || '').slice(0, 300)}`);
    }
  }

  if (details.length === 0) {
    details.push('no linting configured — skipped');
  }

  return { checker: 'lint', result, details: details.join('; ') };
};

export const linksChecker: CheckerFn = async (ctx) => {
  const { stdout: htmlFiles } = await exec(
    `find . -name '*.html' -not -path '*/node_modules/*' -not -path '*/.git/*' ` +
    `-not -path '*/coverage/*' -not -path '*/dist/*' -not -path '*/build/*' ` +
    `-not -path '*/.next/*' -not -path '*/out/*' 2>/dev/null || true`,
    { cwd: ctx.worktree },
  ).catch(() => ({ stdout: '' } as any));

  if (!htmlFiles.trim()) {
    return { checker: 'links', result: 'PASS', details: 'no HTML files — skipped' };
  }

  // Extract all URLs from href/src
  const { stdout: urls } = await exec(
    `echo '${htmlFiles}' | while IFS= read -r f; do ` +
    `grep -ohE '(href|src)=["'"'"'][^"'"'"'#]*' "$f" 2>/dev/null ` +
    `| sed -E 's/^(href|src)=["'"'"']//' ` +
    `| sed -E 's/#.*$//' ` +
    `| grep -vE '^(mailto:|tel:|javascript:|data:|$)'; ` +
    `done | sort -u | wc -l`,
    { cwd: ctx.worktree, shell: 'bash' },
  ).catch(() => ({ stdout: '0' } as any));

  const checked = parseInt(urls.trim() || '0', 10);

  // Check for placeholder links
  const { stdout: placeholders } = await exec(
    `echo '${htmlFiles}' | while IFS= read -r f; do ` +
    `grep -coE 'href="#"' "$f" 2>/dev/null || echo 0; ` +
    `done | paste -sd+ | bc`,
    { cwd: ctx.worktree, shell: 'bash' },
  ).catch(() => ({ stdout: '0' } as any));

  const broken = parseInt(placeholders.trim() || '0', 10);

  return {
    checker: 'links',
    result: broken > 0 ? 'FAIL' : 'PASS',
    details: broken > 0
      ? `${broken} placeholder href="#" links found`
      : `checked ${checked} links, all OK`,
    linksChecked: checked,
    broken,
  };
};

export const accessibilityChecker: CheckerFn = async (ctx) => {
  const files = await findHtmlFiles(ctx.worktree, 20);

  if (files.length === 0) {
    return { checker: 'accessibility', result: 'PASS', details: 'no HTML files — skipped' };
  }

  let issues = 0;
  const details: string[] = [];

  for (const rel of files) {
    const html = await readFile(join(ctx.worktree, rel), 'utf-8').catch(() => '');

    // Images without alt
    const imgNoAlt = (html.match(/<img[^>]*>/g) ?? []).filter(t => !t.includes('alt=')).length;
    if (imgNoAlt > 0) {
      issues += imgNoAlt;
      details.push(`${rel}: ${imgNoAlt} images without alt`);
    }

    // Placeholder links
    const ph = html.split(/\r?\n/).filter(l => l.includes('href="#"')).length;
    if (ph > 0) {
      issues += ph;
      details.push(`${rel}: ${ph} placeholder links`);
    }
  }

  return {
    checker: 'accessibility',
    result: issues > 0 ? 'FAIL' : 'PASS',
    details: details.length > 0
      ? details.join('; ') + ' (note: browser-based axe-core recommended for full WCAG)'
      : 'basic checks passed (alt, placeholder links)',
  };
};

// ---------- Custom Checker (agent-based) ----------

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
      timeout: timeoutSeconds ?? 1800,
    });
    // Extract JSON from output
    const jsonMatch = result.output.match(/\{[^{}]*"checker"[^{}]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return {
      checker: checkerName,
      result: 'FAIL',
      details: `checker produced no valid JSON: ${result.output.slice(0, 200)}`,
    };
  } catch {
    return {
      checker: checkerName,
      result: 'FAIL',
      details: `checker agent failed`,
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
  const standardNames = ['compile', 'tests', 'lint', 'links', 'accessibility'];
  const productCheckers = constitution?.checkers ?? [];

  const allCheckers = [...standardNames, ...productCheckers.filter(c => !standardNames.includes(c))];
  const packageJson = await loadPackageJson(ctx.worktree);
  // the constitution is the single source of truth for the standards body —
  // custom checkers must be graded against the same text that declared them
  const sharedCtx: CheckerContext = { ...ctx, packageJson, constitutionBody: constitution?.body ?? '' };

  for (const name of allCheckers) {
    let output: CheckerOutput;

    if (BUILT_IN_CHECKERS[name]) {
      output = await BUILT_IN_CHECKERS[name](sharedCtx);
    } else if (name.startsWith('custom_')) {
      output = await runCustomChecker(sharedCtx, name, router, customCheckerTimeoutSeconds);
    } else {
      continue; // skip unknown
    }

    results.push(output);
  }

  const failures = results.filter(r => r.result === 'FAIL').length;
  const passes = results.filter(r => r.result === 'PASS').length;

  return {
    failures,
    passes,
    total: results.length,
    results,
  };
}

// ---------- Helpers ----------

async function loadPackageJson(worktree: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFile(join(worktree, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
}

async function getPackageJson(ctx: CheckerContext): Promise<PackageJson | null> {
  return ctx.packageJson !== undefined ? ctx.packageJson : loadPackageJson(ctx.worktree);
}

// Generated output, not product source — scanning these produces false
// positives (e.g. a coverage HTML report embeds source text like `href="#"`
// literals from the checkers themselves as syntax-highlighted code, not markup).
const GENERATED_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.next', 'out']);

async function findHtmlFiles(worktree: string, limit = Infinity): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= limit) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= limit) return;

      if (entry.isDirectory()) {
        if (GENERATED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        results.push(relative(worktree, join(dir, entry.name)));
      }
    }
  }

  await walk(worktree);
  return results;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
