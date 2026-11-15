import { readFileSync } from 'node:fs';

import { defineConfig } from 'oxlint';

// #2777: files over the 500-line limit on main, with the line count recorded when they were
// grandfathered. Each count is that file's own max-lines ceiling, so it can shrink but never grow.
// Never add a new file here. Split the file instead.
// Fix-up steps: .claude/skills/verify/SKILL.md#max-lines-guard.
export const MAX_LINES_BASELINE: Readonly<Record<string, number>> = JSON.parse(
  readFileSync(new URL('./max-lines-baseline.json', import.meta.url), 'utf8'),
);

// #3114/#4050: test files grandfathered with direct mkdtemp(tmpdir()) calls; counts can only shrink,
// never add a file. Use createTempDirs.
export const TMPDIR_MKDTEMP_BASELINE: Readonly<Record<string, number>> = JSON.parse(
  readFileSync(new URL('./tmpdir-mkdtemp-baseline.json', import.meta.url), 'utf8'),
);

// #4051: test files grandfathered with call-count assertions and mock-call reads; counts can only
// shrink, never add a file. Assert observable behaviour instead.
export const CALL_ASSERTIONS_BASELINE: Readonly<Record<string, number>> = JSON.parse(
  readFileSync(new URL('./call-assertions-baseline.json', import.meta.url), 'utf8'),
);

export const COMMENTS_BASELINE: Readonly<Record<string, number>> = JSON.parse(
  readFileSync(new URL('./comments-baseline.json', import.meta.url), 'utf8'),
);

const MAX_LINES_OPTIONS = { skipBlankLines: false, skipComments: false } as const;

export default defineConfig({
  ignorePatterns: ['**/dist/**', 'coverage/**', '.factory/**', 'tools/oxlint/anti-slop/**'],
  // Listing plugins replaces oxlint's default set, so `unicorn` and `oxc` are named here
  // to keep their correctness rules on alongside `typescript` and `promise`.
  plugins: ['typescript', 'unicorn', 'oxc', 'promise'],
  // Vendored, not an npm dependency — see tools/oxlint/anti-slop/VENDORED.md (#795).
  // Oxlint's JS plugin API is alpha and not subject to semver, so @oxlint/plugins is
  // pinned lockstep to oxlint and scripts/check-oxlint-plugin-version.sh guards the pin.
  jsPlugins: [{ name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' }],
  options: {
    typeAware: true,
  },
  rules: {
    // #2776: no file over 500 lines, tests included. Blank lines and comments count.
    // Fix-up steps: .claude/skills/verify/SKILL.md#max-lines-guard.
    'max-lines': ['error', { max: 500, ...MAX_LINES_OPTIONS }],
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
    'typescript/return-await': 'error',
    // typescript/no-base-to-string stays off: 16 hits across fetch-mock tests and error stringifiers, over this audit's fix budget (#4191).
    'typescript/no-base-to-string': 'off',
    // #4056: audited overrides, enabled once their violations were fixed.
    'typescript/no-misused-spread': 'error',
    'typescript/require-array-sort-compare': 'error',
    // typescript/unbound-method stays off: 104 hits across 20+ files, over this audit's fix budget (#4192).
    'typescript/unbound-method': 'off',
    // unicorn/no-thenable stays off: the Gherkin `then` field is a serialized contract field (contracts/gherkin.ts) and renaming it changes issue-body and slice-plan formats (#4193).
    'unicorn/no-thenable': 'off',
    // Slop guards that report zero violations repo-wide. Same rule as anti-slop below: a rule
    // is only listed once the code is clean, never paired with a suppression.
    // Type and suppression slop.
    'typescript/ban-ts-comment': 'error',
    'typescript/prefer-ts-expect-error': 'error',
    'typescript/no-unnecessary-type-parameters': 'error',
    'typescript/no-unnecessary-type-arguments': 'error',
    'typescript/no-unnecessary-type-constraint': 'error',
    'typescript/no-inferrable-types': 'error',
    'typescript/no-empty-object-type': 'error',
    'typescript/no-unsafe-function-type': 'error',
    'typescript/no-unsafe-enum-comparison': 'error',
    'typescript/no-non-null-asserted-nullish-coalescing': 'error',
    'typescript/no-confusing-non-null-assertion': 'error',
    'typescript/no-extraneous-class': 'error',
    'typescript/no-namespace': 'error',
    'typescript/consistent-type-assertions': 'error',
    'typescript/restrict-plus-operands': 'error',
    // #2845: typing and deprecation guards, enabled once their violations were fixed.
    'typescript/switch-exhaustiveness-check': 'error',
    'typescript/no-deprecated': 'error',
    'typescript/no-invalid-void-type': 'error',
    // #2844: error-handling and promise guards, enabled once their violations were fixed.
    // typescript/prefer-promise-reject-errors stays off: tests reject with plain strings on purpose (#2844, #4194).
    'preserve-caught-error': 'error',
    'typescript/no-misused-promises': 'error',
    // typescript/no-dynamic-delete stays off: deletes env vars and keys of persisted Record stores; a Map rewrite changes their JSON (#2846, #4195).
    // no-useless-assignment stays off: 31 hits across 18 files, over this audit's fix budget (#4196).
    // Redundant or dead control flow.
    'no-else-return': 'error',
    'no-useless-return': 'error',
    'no-useless-constructor': 'error',
    'no-useless-computed-key': 'error',
    'no-unneeded-ternary': 'error',
    'no-lonely-if': 'error',
    'prefer-const': 'error',
    'no-param-reassign': 'error',
    'no-useless-concat': 'error',
    'typescript/no-unnecessary-template-expression': 'error',
    'typescript/no-unnecessary-boolean-literal-compare': 'error',
    'unicorn/no-lonely-if': 'error',
    'unicorn/prefer-logical-operator-over-ternary': 'error',
    'no-extra-bind': 'error',
    'no-self-compare': 'error',
    'no-fallthrough': 'error',
    'array-callback-return': 'error',
    'no-implied-eval': 'error',
    // Leftover TODO/FIXME/XXX markers: file an issue instead.
    'no-warning-comments': 'error',
    'unicorn/no-useless-switch-case': 'error',
    'unicorn/no-useless-error-capture-stack-trace': 'error',
    'unicorn/no-static-only-class': 'error',
    'unicorn/no-instanceof-array': 'error',
    'unicorn/prefer-array-some': 'error',
    'unicorn/prefer-set-has': 'error',
    'unicorn/prefer-array-find': 'error',
    // `== null` / `!= null` intentionally matches null and undefined.
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'unicorn/prefer-array-flat-map': 'error',
    'unicorn/prefer-node-protocol': 'error',
    'unicorn/prefer-optional-catch-binding': 'error',
    'unicorn/throw-new-error': 'error',
    'unicorn/prefer-date-now': 'error',
    'unicorn/prefer-object-from-entries': 'error',
    'promise/no-nesting': 'error',
    'promise/no-multiple-resolved': 'error',
    'promise/no-promise-in-callback': 'error',
    // anti-slop (#795): the six generic rules that already report zero violations
    // repo-wide. The remaining seven each land in their own issue with their own fixes;
    // never pair a rule here with a suppression for the code it fires on.
    'anti-slop/no-object-parameters': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-shape-in-symbol-names': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    // #796/#797: repo-wide as of #797 — production and tests alike. A chain is never to be
    // traded for a suppression; widen a double through one named, commented helper instead.
    'anti-slop/no-chained-type-assertions': 'error',
    // #798/#1975: repo-wide. Replace dependencies through a real injected seam, never vi.mock/jest.mock.
    'anti-slop/no-module-mocking': 'error',
    // #4050: no direct mkdtemp(tmpdir()) in tests; per-file allowances come from the baseline overrides.
    'anti-slop/no-direct-tmpdir-mkdtemp': 'error',
    // #4051: no call-count assertions or mock-call reads in tests; per-file allowances come from the baseline overrides.
    'anti-slop/no-call-assertions': 'error',
    // #4053: comments are banned except justified lint overrides and toolchain directives; allowances come from the baseline overrides.
    'anti-slop/no-comments': 'error',
    // #4052: package boundaries (config ← core ← cli, published-name imports, ADR-0004 subpaths).
    // scripts/eval.ts runs the stub eval with StubModelExecutor from /testing (ADR-0004: "exercise
    // the factory without real model CLIs"), so it is the one non-test file allowed to import it.
    'anti-slop/package-boundaries': ['error', { testingAllowedFiles: ['scripts/eval.ts'] }],
  },
  overrides: [
    ...Object.entries(MAX_LINES_BASELINE).map(([file, max]) => ({
      files: [file],
      rules: { 'max-lines': ['error', { max, ...MAX_LINES_OPTIONS }] },
    })),
    ...Object.entries(TMPDIR_MKDTEMP_BASELINE).map(([file, allowed]) => ({
      files: [file],
      rules: { 'anti-slop/no-direct-tmpdir-mkdtemp': ['error', { allowed }] },
    })),
    ...Object.entries(CALL_ASSERTIONS_BASELINE).map(([file, allowed]) => ({
      files: [file],
      rules: { 'anti-slop/no-call-assertions': ['error', { allowed }] },
    })),
    ...Object.entries(COMMENTS_BASELINE).map(([file, allowed]) => ({
      files: [file.includes('/') ? file : `./${file}`],
      rules: { 'anti-slop/no-comments': ['error', { allowed }] },
    })),
  ],
});
