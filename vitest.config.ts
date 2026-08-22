import { configDefaults, defineConfig } from 'vitest/config';

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
 */
const INTEGRATION_GLOB = '**/*.integration.test.{ts,tsx}';
const integrationOnly = process.env.FACTORY_INTEGRATION_TESTS === '1';

export default defineConfig({
  test: {
    // Coverage instrumentation across the monorepo is memory-intensive. Keep
    // files serial so the required full-suite check stays within CI's heap
    // limit instead of loading several instrumented workspace graphs at once.
    fileParallelism: false,
    // Discover tests across all workspaces in one run so coverage aggregates.
    include: [integrationOnly ? `packages/*/src/${INTEGRATION_GLOB}` : 'packages/*/src/**/*.test.{ts,tsx}'],
    exclude: integrationOnly ? configDefaults.exclude : [...configDefaults.exclude, INTEGRATION_GLOB],
    coverage: {
      provider: 'v8',
      // 'text' prints the per-file table; 'text-summary' prints the totals line.
      reporter: ['text', 'text-summary', 'html', 'json-summary', 'lcov', 'cobertura'],
      include: ['packages/*/src/**/*.{ts,tsx}'],
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
        // Test-only fixture kit (throwaway repos, fake Octokit) exercised by the
        // integration suites; it is scaffolding, not product code, and its fake
        // branches would only dilute the gate.
        'packages/core/src/test-support/**',
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
        branches: 90,
        statements: 96,
        // RATCHET per package: each metric set at the measured floor. Vitest 4
        // rebaselines the V8 mapping results, so these values are reset once
        // here and remain a non-decreasing guard afterwards.
        'packages/adr-kit/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 91, statements: 98 },
        'packages/config/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 49, statements: 99 },
        'packages/contracts/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 99, statements: 99 },
        'packages/repo-context/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 98, statements: 99 },
        'packages/core/src/**/*.{ts,tsx}': { lines: 97, functions: 96, branches: 88.9, statements: 96 },
        // branches: measured 88.72 on main both with and without the integration
        // suites — this floor was already unmet before #755 touched anything, and
        // moving the integration suites to nightly does not change any metric here.
        'packages/cli/src/**/*.{ts,tsx}': { lines: 97, functions: 88, branches: 88, statements: 97 },
        'packages/dashboard/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 99, statements: 99 },
        'packages/product/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 98, statements: 99 },
        'packages/server/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 99, statements: 99 },
        'packages/scbench-adapter/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 95, statements: 98 },
      },
    },
  },
});
