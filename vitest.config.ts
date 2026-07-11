import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Discover tests across all workspaces in one run so coverage aggregates.
    include: ['src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // 'text' prints the per-file table; 'text-summary' prints the totals line.
      reporter: ['text', 'text-summary', 'html', 'json-summary'],
      include: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
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
        // RATCHET: set to today's floor, capped at 80. Raise toward
        // 100 as tracks A/B add tests. All four kept equal for a simple global gate.
        lines: 22,
        functions: 22,
        branches: 22,
        statements: 22,
      },
    },
  },
});
