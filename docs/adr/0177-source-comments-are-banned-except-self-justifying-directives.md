# ADR-0177: Source comments are banned except self-justifying directives

- Status: Accepted
- Date: 2026-11-14
- See also: [ADR-0164](0164-enforcement-ladder.md)

## Context

Rules written as comments go stale, and agents cite them to justify workarounds. A rule belongs in a type, a test or a lint rule, where it fails loudly. The repo already ratchets call-count assertions and tmpdir use with shrink-only baselines (#4050, #4051); comments get the same treatment.

## Decision

1. **Allowed forms.** `anti-slop/no-comments` reports every comment in `.ts`, `.tsx`, `.mts`, `.js` and `.mjs` files except:
   - `eslint-` and `oxlint-` disable directives that name rules and carry `-- <reason or #issue>`, and `enable` directives that name rules;
   - `@ts-expect-error` with a reason, `prettier-ignore`, `Stryker disable` with `: <reason>`, `Stryker restore`, `@vitest-environment`, `v8`/`c8 ignore` with `-- <reason>` (`stop` needs none), triple-slash references and `#__PURE__` annotations;
   - a comment directly above a property of a `rules` object in `oxlint.config.ts`.

   A directive missing its required reason is reported as a bad directive and is never baselined. No directive may name `anti-slop/no-comments`.

2. **JSDoc gets no exception.** `scripts/gen-config-example.ts`, `scripts/gen-cli-json-schemas.ts`, `scripts/adr-index.ts` and CLI help read no comments, and there is no API-doc build. The only consumer is tsc's `.d.ts` emit for editor hovers (`declaration: true` in `tsconfig.base.json`), which is not a build input.
3. **Known JSDoc reader.** `packages/config/src/defaults.test.ts` reads JSDoc from `defaults.ts`. That file stays baselined, and the issue that removes existing comments replaces those tests.
4. **Deleted rule.** `anti-slop/require-safety-comment-for-type-assertion` is deleted and not re-vendored. It demanded a comment, which this rule forbids; a named helper replaces any type assertion that needs justifying.
5. **Shrink-only baseline.** Existing comments are grandfathered per file in `comments-baseline.json`. A stale allowance fails lint until lowered, and `scripts/comments-baseline-guard.ts` fails CI when a pull request adds or raises an entry. There is no label override.

## Consequences

- New comments fail `npm run lint`; existing ones are removed file by file in later work.
- Editor hovers lose JSDoc as files are cleaned up.
- Overrides always carry a reason that survives review.

## Alternatives considered

- **Allow JSDoc on exports.** Rejected: no tool consumes it, and it goes stale like any comment.
- **Allow `@ts-ignore`.** Rejected: `@ts-expect-error` with a reason fails when the error disappears.
