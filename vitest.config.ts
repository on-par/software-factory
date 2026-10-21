import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

import { resolveTestMaxWorkers } from './scripts/test-workers.js';

/**
 * The pipeline integration suites drive whole plan->build->check->ship cycles
 * against real git worktrees on disk. They are the only tests that shell out to
 * git, so they carry the widest blast radius of any suite here: a wedged git
 * subprocess or a corrupted worktree takes the whole run with it. Keeping them
 * off the required `ci` check means such a failure can never strand every open
 * PR behind it (#755).
 *
 * Default run  -> every suite except the integration ones (this is `npm test`,
 *                 and therefore the required `ci` check).
 * FACTORY_INTEGRATION_TESTS=1 -> only the integration suites. That is
 *                 `npm run test:integration`, run nightly by
 *                 .github/workflows/nightly-integration.yml.
 * FACTORY_REAL_CLI=<agent> -> only the real-CLI suites, run nightly by
 *                 .github/workflows/nightly-real-cli.yml.
 */
const INTEGRATION_GLOB = '**/*.integration.test.{ts,tsx}';
const REAL_CLI_GLOB = '**/*.real-cli.test.{ts,tsx}';
const integrationOnly = process.env.FACTORY_INTEGRATION_TESTS === '1';
const realCliOnly = Boolean(process.env.FACTORY_REAL_CLI);
const maxWorkers = resolveTestMaxWorkers(process.env);

export default defineConfig({
  // Pin the project root to this config's directory. Without it, vitest run
  // from inside a workspace package (npm test --workspace packages/<name>)
  // resolves the include globs against that package's cwd and finds zero
  // test files — the packages/core "test script" agent trap in AGENTS.md.
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    // One per-run TMPDIR sandbox, removed at the end, plus a guard that names prefixes leaking into the real TMPDIR (#3114).
    globalSetup: [fileURLToPath(new URL('./scripts/test-tmp-sandbox.ts', import.meta.url))],
    setupFiles: [fileURLToPath(new URL('./packages/core/src/test-support/setup-env.ts', import.meta.url))],
    // Test files run in parallel with 4 workers by default (DEFAULT_TEST_MAX_WORKERS
    // in scripts/test-workers.ts), bounded so the instrumented coverage run stays
    // inside CI's heap limit and 4 vCPUs (measured in
    // docs/research/coverage-worker-scaling-2752.md). Set FACTORY_TEST_MAX_WORKERS=N
    // to change it and FACTORY_TEST_MAX_WORKERS=1 to run serially.
    maxWorkers,
    fileParallelism: maxWorkers > 1,
    // Many unit suites spawn real subprocesses (git init/clone/push/worktree,
    // shells, CLIs) against throwaway temp repos. Each such test takes ~0.3-0.5s
    // on an idle machine, but the factory runs this suite (via verify.sh) on a
    // shared Mac Mini that is routinely at load average 80-200 on 10 cores, where
    // the same tests stretch to 1-5s+ and vitest's 5s default deadline fails
    // them at random. That flake reported main as red at 9024b07 and parked
    // #2269 on "base-red" (Gate 0). It is CPU and process-spawn starvation, not
    // a hang or a race: the slowdown is uniform across every git-backed test, a
    // test that times out keeps running and finishes on its own, and the
    // failing set changes from run to run. 30s keeps a real hang failing fast
    // while giving loaded hosts ~6x headroom. Hooks get the same budget because
    // their cleanup (git worktree remove, rm -rf of temp repos) is the same work.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Discover tests across all workspaces in one run so coverage aggregates.
    // scripts/ helpers with logic carry colocated tests too.
    include: realCliOnly
      ? [`packages/*/src/${REAL_CLI_GLOB}`]
      : integrationOnly
        ? [`packages/*/src/${INTEGRATION_GLOB}`]
        : ['packages/*/src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    exclude: realCliOnly
      ? configDefaults.exclude
      : integrationOnly
        ? [...configDefaults.exclude, REAL_CLI_GLOB]
        : [...configDefaults.exclude, INTEGRATION_GLOB, REAL_CLI_GLOB],
    coverage: {
      provider: 'v8',
      // 'text' prints the per-file table; 'text-summary' prints the totals line.
      reporter: ['text', 'text-summary', 'html', 'json-summary', 'lcov', 'cobertura'],
      // scripts/pack-hygiene.ts is the tarball guard behind every package's prepack and
      // the quickstart pack check (#2336); its bin shim (pack-hygiene-cli.ts) stays out.
      include: ['packages/*/src/**/*.{ts,tsx}', 'scripts/pack-hygiene.ts'],
      exclude: [
        ...configDefaults.coverage.exclude,
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        '**/dist/**',
        // Types-only module (all `export type`/`export interface`, no executable
        // statements) — reports 0% and would only dilute the gate.
        'packages/core/src/types/**',
        // DOM bootstrap entry (createRoot side effect) — not exercisable in unit
        // tests; the page itself is covered via App.test.tsx.
        'packages/dashboard/src/main.tsx',
        // Product bin shim — a single runEntry(main) call; runEntry is covered by entry.test.ts.
        'packages/product/src/cli.ts',
        // CLI bin shim — a single runEntry(loader) call; runEntry is covered by entry.test.ts.
        'packages/cli/src/cli.ts',
        // scbench-adapter bin shim — a single runEntry(main) call; runEntry is covered by entry.test.ts.
        'packages/scbench-adapter/src/cli.ts',
        // Test-only fixture kit (throwaway repos, fake Octokit) exercised by the
        // integration suites; it is scaffolding, not product code, and its fake
        // branches would only dilute the gate.
        'packages/core/src/test-support/**',
        // Test-only shipIssue harness for the cli ship*.test.ts suites (#2789).
        'packages/cli/src/**/test-support/**',
      ],
      thresholds: {
        // RATCHET: global catch-all. Files matched by the per-package globs below
        // are REMOVED from this pool (Vitest glob-threshold semantics), so this
        // now only guards files in any future package that lacks its own glob.
        // scripts/coverage-ratchet.ts (run by verify.sh and CI) fails the
        // build if measured coverage exceeds these by >2pts — raise them here
        // in the same PR when it fires.
        lines: 97,
        functions: 95,
        branches: 91,
        statements: 96,
        // RATCHET per package: each metric set at the measured floor. Vitest 4
        // rebaselines the V8 mapping results, so these values are reset once
        // here and remain a non-decreasing guard afterwards.
        'packages/adr-kit/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 92, statements: 98 },
        'packages/config/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 100, statements: 99 },
        'packages/contracts/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 99, statements: 99 },
        'packages/repo-context/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 98, statements: 99 },
        'packages/core/src/**/*.{ts,tsx}': { lines: 97, functions: 96, branches: 90, statements: 96 },
        // branches: measured 88.72 on main both with and without the integration
        // suites — this floor was already unmet before #755 touched anything, and
        // moving the integration suites to nightly does not change any metric here.
        'packages/cli/src/**/*.{ts,tsx}': { lines: 97, functions: 92, branches: 91, statements: 96.9 },
        'packages/dashboard/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 99, statements: 99 },
        'packages/product/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 98, statements: 99 },
        'packages/server/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 99, statements: 99 },
        'packages/grade/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 96, statements: 98 },
        'packages/scbench-adapter/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 96, statements: 98 },
        'scripts/pack-hygiene.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
      },
    },
  },
});
