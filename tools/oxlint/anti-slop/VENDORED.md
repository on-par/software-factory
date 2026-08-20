# Vendored: anti-slop oxlint plugin

- **Upstream**: <https://github.com/dmmulroy/anti-slop> (MIT — see `LICENSE` next to this file).
- **Pinned commit**: `6d538555cb151d4121ed51a27db81890eacf8ae9`, copied 2026-08-18.
- **Verbatim copy, no local modifications.** This directory is a byte-faithful mirror of
  upstream's `src/`. Re-syncing to a newer upstream commit is a plain diff against the pinned
  commit above, not an archaeology exercise.
- Upstream is `"private": true` and unpublished — its README states it is designed to be
  vendored and edited in-repo, not consumed as a pinned npm dependency, which is why this tree
  exists instead of a `package.json` entry.

## What's registered

Only `index.ts` is registered, via `jsPlugins` in the repo root's `oxlint.config.ts`, under the
alias `anti-slop`. `effect/index.ts` is vendored for mirror fidelity but is intentionally **not**
registered — no package in this repo depends on `effect`.

Of `index.ts`'s fifteen generic rules, only a subset is enabled at any time (see `oxlint.config.ts`
for the current list). Rules are enabled one landing at a time, only once they measure zero
violations against this repo. The remaining rules each land in their own issue with their own
fix. A rule is never enabled together with a suppression for the code it fires on.

## Excluded from every other repo gate

This tree is not workspace TypeScript. It is excluded, at its own boundary, from:

- **oxlint** — `ignorePatterns` in `oxlint.config.ts` (it must not lint itself).
- **prettier** — `.prettierignore` (upstream mixes tab and space indentation; reformatting it
  would destroy the verbatim-mirror property the pinned commit depends on).
- **knip** — `knip.jsonc` (`ignore` for the tree, `ignoreDependencies` for `@oxlint/plugins`,
  which only this tree imports).
- **vitest** — no change needed; its include glob is `packages/*/src/**/*.test.{ts,tsx}`, which
  this tree sits outside of by construction. That's also why this plugin lives under `tools/`
  rather than inside a workspace package.

Nothing under this directory is linted, formatted, type-checked, or unit-tested by this repo's
gates — upstream owns the correctness of these files, and we pin the commit.

## Re-sync procedure

```bash
rm -rf /tmp/anti-slop
git clone https://github.com/dmmulroy/anti-slop.git /tmp/anti-slop
git -C /tmp/anti-slop checkout <new-sha>
cp -R /tmp/anti-slop/src/. tools/oxlint/anti-slop/
cp /tmp/anti-slop/LICENSE tools/oxlint/anti-slop/LICENSE
```

Then update the pinned commit recorded at the top of this file, and run `bash scripts/verify.sh`.
