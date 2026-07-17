import eslint from '@eslint/js';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import tseslint from 'typescript-eslint';

// Non-type-aware linting only: the root TypeScript is the native (Go) compiler,
// which has no JS compiler API for typescript-eslint's type-aware rules.
// This workspace carries its own TypeScript 5.x for parsing (see package.json).
export default tseslint.config(
  { ignores: ['**/dist/**', 'coverage/**', '.factory/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [eslint.configs.recommended, tseslint.configs.recommended],
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      // Lean initial gate (#140): `any` is pervasive (300+ occurrences, mostly tests);
      // tightening it is a follow-up.
      '@typescript-eslint/no-explicit-any': 'off',
      // House convention: underscore-prefixed identifiers are intentionally unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Empty catch is the established best-effort pattern (ship.ts, cli, worktree-gc).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // House import style (#142): types via `import type`, blocks sorted.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
  },
);
