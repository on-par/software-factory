import { defineConfig } from 'oxlint';

export default defineConfig({
  ignorePatterns: ['**/dist/**', 'coverage/**', '.factory/**', 'tools/oxlint/anti-slop/**'],
  plugins: ['typescript'],
  // Vendored, not an npm dependency — see tools/oxlint/anti-slop/VENDORED.md (#795).
  // Oxlint's JS plugin API is alpha and not subject to semver, so @oxlint/plugins is
  // pinned lockstep to oxlint and scripts/check-oxlint-plugin-version.sh guards the pin.
  jsPlugins: [{ name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' }],
  options: {
    typeAware: true,
  },
  rules: {
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    'typescript/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'separate-type-imports' }],
    'typescript/no-floating-promises': 'error',
    'typescript/no-base-to-string': 'off',
    'typescript/no-misused-spread': 'off',
    'typescript/require-array-sort-compare': 'off',
    'typescript/unbound-method': 'off',
    // anti-slop (#795): the six generic rules that already report zero violations
    // repo-wide. The remaining nine each land in their own issue with their own fixes;
    // never pair a rule here with a suppression for the code it fires on.
    'anti-slop/no-object-parameters': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-shape-in-symbol-names': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    // #796: the one anti-slop rule that found real defects here. Production is clean;
    // test files are exempted below until the follow-up clears their ~28 chains.
    'anti-slop/no-chained-type-assertions': 'error',
  },
  overrides: [
    {
      // Test files still carry ~28 chained assertions (mostly around fetch/octokit doubles).
      // Exempted here so #796 stays small and its production risk is isolated; cleared by #797.
      files: ['**/*.test.ts', '**/*.test.tsx'],
      rules: {
        'anti-slop/no-chained-type-assertions': 'off',
      },
    },
  ],
});
