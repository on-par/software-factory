# npm vs. Homebrew distribution for the `factory` CLI (Issue #880)

Date: 2026-08-26

## Purpose and scope

The factory is public enough now that people may want to install and run the
`factory` CLI outside this checkout, but the distribution story is not written
down. This is the #880 discovery document: it evaluates the two candidate
channels (npm and Homebrew), inventories the npm-readiness work already done
versus still missing, defines a minimal install-and-run smoke plan, and
records a concrete recommendation with sequencing. It is advisory, not
binding — it does not publish anything, create a tap, or change any package,
workflow, or source file. Every claim about this checkout is grounded in a
`file:line` citation.

## 1. Recommendation

**Recommend npm as the initial and primary distribution channel. Defer
Homebrew.** The CLI is a Node.js package; npm is its native channel, is
already wired (the README documents `npm install -g @on-par/factory-cli`,
`README.md:71`), and requires no separate bundling or packaging format.
Homebrew adds a second channel to maintain and is best introduced only after
npm publishing is proven and stable.

Sequencing: ship npm first (close the gaps in section 3), prove it with the
smoke plan (section 4), then reconsider Homebrew only once there is install
demand from users without a Node toolchain (section 5).

## 2. Current state inventory (what already exists)

- `packages/cli/package.json` is already publish-shaped: `"bin": { "factory":
"dist/cli.js" }`, `"files": ["dist"]`, `"publishConfig": { "access":
"public" }`, `repository.directory`, `homepage`, `bugs`, `engines.node`, and
  `"prepublishOnly": "npm run build"` (`packages/cli/package.json:1-38`).
- `packages/cli/src/cli.ts` starts with the `#!/usr/bin/env node` shebang, so
  the installed `factory` bin is directly executable (`packages/cli/src/cli.ts:1`).
- All seven packages in the CLI's runtime dependency closure are public
  (`"private"` unset/false, each with `publishConfig.access: "public"`):
  `@on-par/factory-cli` depends on `@on-par/factory-core` and
  `@on-par/factory-tui`; `@on-par/factory-core` depends on `@on-par/adr-kit`,
  `@on-par/contracts`, `@on-par/factory-config`, and `@on-par/repo-context`;
  `@on-par/factory-tui` depends on `@on-par/factory-core`. Internal
  dependencies use published semver ranges (`^2.0.0`), not the `workspace:`
  protocol, so they resolve from the registry once published
  (`packages/cli/package.json:31-38`).
- `.github/workflows/publish.yml` already exists: it triggers on `v*` tags,
  runs `scripts/verify.sh` and `scripts/quickstart-smoke.sh`, gates on issues
  #195 and #151 being CLOSED, and publishes with `NODE_AUTH_TOKEN` from
  `secrets.NPM_TOKEN` (`.github/workflows/publish.yml:1-33`).
- `scripts/quickstart-smoke.sh` already packs and installs the full
  seven-package closure into a fresh project and asserts `factory --version`,
  `factory --help`, and `factory init` (`scripts/quickstart-smoke.sh:1-60`).

## 3. npm readiness work still required (the follow-up backlog)

- **Publish-set gap (highest priority).** `.github/workflows/publish.yml`'s
  final step publishes only `@on-par/factory-config`, `@on-par/factory-core`,
  and `@on-par/factory-cli` (`.github/workflows/publish.yml:33`). But the
  CLI's runtime closure needs all seven packages — it also requires
  `@on-par/factory-tui`, `@on-par/adr-kit`, `@on-par/contracts`, and
  `@on-par/repo-context`. As written, a registry install of
  `@on-par/factory-cli` would fail to resolve those four missing
  dependencies. The follow-up ticket must extend the publish workflow's
  `npm publish --workspace ...` list to the same seven-package set that
  `scripts/quickstart-smoke.sh` already packs
  (`scripts/quickstart-smoke.sh:19-27`), and keep the two lists in sync going
  forward.
- **Release-gate confirmation.** Publishing is blocked until issues #195 and
  #151 are CLOSED (`.github/workflows/publish.yml:24-30`). The follow-up work
  should confirm/track those blockers before the first real tag.
- **First-publish prerequisites to verify (not necessarily change):** an
  `NPM_TOKEN` secret with publish rights to the `@on-par` scope must exist;
  the `@on-par` npm org/scope must exist and allow public scoped publishes;
  version `2.0.0` must be unpublished on the registry for all seven package
  names (this would be a first publish); and a version-bump/tagging
  convention must be chosen, since a git tag matching `v*` is what drives
  `publish.yml` (`.github/workflows/publish.yml:2-4`).
- **`files` field consistency (note, low priority).** Most packages ship only
  `["dist"]`; `packages/config/package.json` also ships `src`
  (`packages/config/package.json:16-19`). Flag this as a deliberate-or-not
  check for the publishing follow-up ticket, not a blocker.
- The README already claims installability (`README.md:71`), so no new
  install copy is needed there — only the workflow/publish-set fix above is
  functionally required before a real publish would work end to end.

## 4. Install smoke-test plan

- The existing `scripts/quickstart-smoke.sh` is the canonical smoke test.
  It packs all seven closure packages with `npm pack`, installs the tarballs
  into a fresh throwaway project (mirroring a registry install), and asserts
  `factory --version` equals the CLI's own `package.json` version,
  `factory --help` contains "Prerequisites", and `factory init` creates
  `.factory/` (`scripts/quickstart-smoke.sh:29-60`). `publish.yml` already
  runs this script before every real publish (`.github/workflows/publish.yml:19-20`).
- Minimal post-publish verification to add to the follow-up ticket: from a
  clean machine or container, run `npm install -g
@on-par/factory-cli@<version>`, then `factory --version` and
  `factory --help`. This is the true end-to-end proof that the published
  closure resolves from the live registry — the local smoke test installs
  from tarballs, not from npmjs.org, so it cannot catch a registry-side gap
  (e.g. a dependency that was never actually published).

## 5. Homebrew evaluation

A Homebrew formula for a Node CLI either (a) depends on the `node` formula
and effectively wraps `npm install -g`, duplicating the npm channel with
extra maintenance (a formula to keep in sync on every release), or (b) ships
a standalone bundled binary (e.g. via a single-file build step that does not
exist in this repo today), which is a larger, separate effort requiring new
build tooling. Either path is strictly downstream of a working npm publish:
option (a) has nothing to wrap until npm publishing works, and option (b)
would still want npm as the reference distribution to validate a bundled
build against.

Recommend revisiting Homebrew only after npm is live and there is concrete
install demand from users who do not have a Node toolchain available.

## Non-goals

This document does not publish any package to npm, create a Homebrew tap or
formula, or change `factory` runtime behavior, any `package.json`,
`publish.yml`, or `quickstart-smoke.sh`. Those are the follow-up
implementation tickets this document enumerates (chiefly section 3's
publish-set gap).
