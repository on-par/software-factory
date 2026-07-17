import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Discover tests across all workspaces in one run so coverage aggregates.
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
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
        // SaaS server is an unwired stub with no tests yet (see FACTORY_COMPARISON.md);
        // it would only dilute the gate. Bring it under coverage when it gets tests.
        'packages/server/**',
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
        lines: 95,
        functions: 92,
        branches: 88,
        statements: 95,
        // RATCHET per package: each metric set ~1 point below that package's
        // measured floor (see #242). Raise toward 100 as coverage grows; never
        // lower. Package-scoped so one workspace cannot hide another workspace's
        // regression behind the aggregate average.
        'packages/config/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 49, statements: 99 },
        'packages/core/src/**/*.{ts,tsx}': { lines: 95, functions: 94, branches: 87, statements: 95 },
        'packages/cli/src/**/*.{ts,tsx}': { lines: 94, functions: 84, branches: 90, statements: 94 },
        'packages/dashboard/src/**/*.{ts,tsx}': { lines: 99, functions: 99, branches: 99, statements: 99 },
      },
    },
  },
});
