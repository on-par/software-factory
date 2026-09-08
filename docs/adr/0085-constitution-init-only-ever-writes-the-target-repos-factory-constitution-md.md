# ADR-0085: `constitution --init` only ever writes the target repo's `.factory/constitution.md`

- Status: Accepted
- Date: 2026-09-07

## Context

`factory constitution --init <product>` used to scaffold
`getConstitutionsDir()/<product>.md` — a file inside the installed
`@on-par/factory-config` package, not inside the user's repo. That directory
is package-internal: it ships the bundled product constitutions and their
`_template.md` skeleton, and is read by `ConstitutionLoader` and by `factory
init`/`factory migrate` when resolving a repo's active product. A CLI
invocation writing into it is a write to installed package contents — it
silently mutates (or, worse, fails to persist across reinstalls/upgrades)
package state a running `factory` process does not own, and diverges from
every other `--init`-style command in this CLI, which write into the
target repo's `.factory/`. Bare `factory constitution --init` (no product
name) already wrote `.factory/constitution.md` in the repo; only the named
form wrote into the package directory, an inconsistency with no
corresponding use case once both are stated side by side.

## Decision

`factory constitution --init [product]` always writes
`.factory/constitution.md` in the current repo, scaffolded from
`getConstitutionsDir()/_template.md`. The optional `<product>` argument now
only supplies the display name/`<product-name>` fill for the scaffold
(replacing the derived `basename(repoRoot)`) — it is no longer a filename
under `getConstitutionsDir()`. `--force` behaves identically for both the
bare and named forms (overwrite an existing `.factory/constitution.md`).
`getConstitutionsDir()` itself, `ConstitutionLoader`, and every other
caller of it (`factory init`, `factory migrate`, `--list`, `--product`) are
unaffected — the function still resolves and reads from the same
package-internal directory; only the `--init` write path stops targeting
it. `initConstitution()`, `InitConstitutionDeps`, and
`ConstitutionExistsError` are deleted as dead code; the "already exists"
CLI error now comes from the shared `.factory/constitution.md` check.

## Consequences

Positive: `--init` cannot corrupt or leave stray files in the installed
`@on-par/factory-config` package; both `--init` forms funnel through the
same write, exit codes, and `--force` semantics, which is simpler to reason
about and test. Negative: there is no longer a CLI-driven way to seed a new
_bundled_ product constitution under `getConstitutionsDir()` for reuse
across repos — adding one now requires editing the `factory-config` package
source directly (a maintainer/PR action, consistent with the rest of that
package's zero-runtime-write contract).

## References

- [Issue #1299](https://github.com/on-par/software-factory/issues/1299)
- [Issue #1278](https://github.com/on-par/software-factory/issues/1278)
