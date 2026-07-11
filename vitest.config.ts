import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Discover tests across all workspaces in one run so coverage aggregates.
    include: ['packages/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // 'text' prints the per-file table; 'text-summary' prints the totals line.
      reporter: ['text', 'text-summary', 'html', 'json-summary'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        ...configDefaults.coverage.exclude,
        '**/*.test.ts',
        '**/*.d.ts',
        '**/dist/**',
        // SaaS server is an unwired stub with no tests yet (see FACTORY_COMPARISON.md);
        // it would only dilute the gate. Bring it under coverage when it gets tests.
        'packages/server/**',
      ],
      thresholds: {
        // RATCHET: each metric set ~2 points below the measured floor on
        // main (branches capped at 80 per the hard cap). Raise toward 100
        // as coverage grows; hard cap at 80.
        lines: 73,
        functions: 75,
        branches: 80,
        statements: 73,
      },
    },
  },
});
