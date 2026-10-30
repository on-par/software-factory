# Docs and CHANGELOG

Reference: #3676 (this process), #1974 (release automation). Every change keeps the
user-facing docs and `CHANGELOG.md` current in the same PR, so a release never needs a
catch-up pass.

## Every PR

1. **CHANGELOG.** If users or operators can see the change, add an entry under
   `## Unreleased` in `CHANGELOG.md`, in `### Added`, `### Changed` or `### Fixed`. Write
   a one-line summary and end it with the issue or PR number, for example `(#1234)`.
   Skip pure chore and test-only changes, unless they change `factory doctor` or CLI
   behavior.
2. **Living docs.** If behavior users see changes, update the matching doc in the same PR:

   | Doc                                | Covers                       |
   | ---------------------------------- | ---------------------------- |
   | `README.md`                        | install, safety, CLI surface |
   | `docs/status.md`                   | what works vs experimental   |
   | `docs/agents.md`, `docs/models.md` | harness and model matrix     |
   | `docs/ops/*`, `docs/runbooks/*`    | operator flows               |

3. **ADRs.** Record significant design decisions as ADRs in `docs/adr/` (the
   [AGENTS.md](../../AGENTS.md) rule). Do not copy ADR content into the README.

Do not edit `version` in any `package.json` on a feature PR. See [Versions](#versions).

## Changelog shape

Use Keep a Changelog headings with issue-linked summaries, not a list of conventional
commits. This resolves the "changelog shape" question in #1974. Put the newest section
first:

```markdown
## Unreleased

### Fixed

- `factory land` ... (#1234)

## 0.9.17 - 2026-10-24

One or two sentences on what the release is about. All seven published `@on-par`
packages move to 0.9.17 in lockstep. Install or update with
`npm install -g @on-par/factory-cli@latest`.

### Added
```

## Stable release

The publish gate reads `CHANGELOG.md` at the tagged commit, so promote the changelog on
`main` before you tag:

1. In a PR, rename `## Unreleased` to `## X.Y.Z - YYYY-MM-DD` for the version you will
   tag, and add the short intro.
2. In the same PR, add a new empty `## Unreleased` above it.
3. Merge the PR.
4. Tag a commit that contains the promoted section and push the tag:
   `git tag vX.Y.Z <sha> && git push origin vX.Y.Z`.

A release job (#1974) must also promote `Unreleased` before it creates the tag, not after.

## Publish gate

`scripts/publish-release.sh` (the "Publish to npm" step of `.github/workflows/publish.yml`)
refuses a stable `vX.Y.Z` tag, dry runs included, unless `CHANGELOG.md` has a heading
`## X.Y.Z` or `## [X.Y.Z]`. A date may follow the version. The check runs before any
package version is set or npm is called, so nothing is published. The job fails and the
job summary reads:

```
NOT PUBLISHED: CHANGELOG.md has no ## X.Y.Z section; promote Unreleased first (docs/ops/docs-and-changelog.md)
```

`vX.Y.Z-next.N` tags and the `next` prereleases published from `main` are not gated.

If the gate stops a tag: land the promotion PR, then move the tag to a commit that has the
section and push it again. The version is still free on npm.

## Versions

The `version` fields in the root and `packages/*/package.json` files on `main` are not the
released version. They stay at the last committed version (0.9.25). The publish job
writes the tag's version, or the next prerelease version, into the packages at build time
with `scripts/set-release-version.sh` and never commits it. To see the real versions, run
`factory --version` or `npm view @on-par/factory-cli dist-tags`.
