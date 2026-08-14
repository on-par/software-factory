# Deployment automation audit across on-par projects (Issue #624)

Date: 2026-08-14

## Purpose and scope

This is the #624 discovery audit of what deployment/provisioning automation
already exists, ad hoc, across the on-par repos — before any general AWS/Azure
provisioning capability is designed. It inventories each pipeline that
automates part of "get a build out the door", records which steps stayed
human-gated and why, and synthesizes the patterns that proved necessary in
practice. It is a **discovery artifact, not a design**: it makes no AWS/Azure
recommendation, picks no provisioning architecture, and adds no ADR — the
provisioning decision belongs to a follow-up story, exactly as the issue's
sequencing ("Before designing a general AWS/Azure provisioning capability, we
need to know what has already been hand-built") demands.

Pipelines audited, grounded in direct reading of the sibling checkouts:

- **playlift** — EAS Build → TestFlight / App Store (`apps/mobile/eas.json`,
  `apps/mobile/docs/testflight.md`, unmerged `ship-it/*` branches #111–#115).
- **sound-buddy** — Developer ID signing + `notarytool` notarization
  (`docs/signing-and-notarization.md`, `scripts/release.sh`,
  `.github/workflows/release.yml`), plus the site (`site/wrangler.jsonc`).
- **launchblitz** — Vercel deployment plan (`docs/deployment.md`).
- **software-factory (this repo)** — the factory's own launchd LaunchAgent
  merge-sweeper and cost-KPI machinery (ADR-0020, `.factory/costs.jsonl`).
- **mckinnis-edit-site** — gh-pages force-push deploy (`deploy.sh`).

Other on-par repos (mia-v3, co-adapt-agents, chronica, ampshot) have no deploy
pipeline discovered in their checkouts and are not audited.

## playlift — EAS Build → TestFlight / App Store

### What is automated

`apps/mobile/eas.json` (working tree, uncommitted-modified) defines three EAS
Build profiles and an App Store Connect submit block:

- `development` — internal dev client (`eas.json:6-10`).
- `preview` — internal, iOS simulator (`eas.json:11-14`).
- `production` — `autoIncrement: true` (build number bumps automatically)
  (`eas.json:15-18`).
- `submit.production.ios` — wired for `eas build --auto-submit` to App Store
  Connect: `ascAppId` `6799811668`, `ascApiKeyId` `YA86X5XVAT`,
  `ascApiKeyIssuerId`, `ascApiKeyPath ./AuthKey_YA86X5XVAT.p8`
  (`eas.json:19-28`).

Once the one-time prerequisites (below) exist, the EAS side is fully
automated: `npm run submit:ios` (`apps/mobile/package.json` on branch
`b352ce1`, `eas build --platform ios --profile production --auto-submit`)
builds a production `.ipa` and uploads it straight to TestFlight, where it
moves through Apple's processing to assignable testers with no manual steps
(`apps/mobile/docs/testflight.md`, "Running it"). `appVersionSource: "remote"`
(`eas.json:4`) keeps versions tracked in EAS rather than the working tree.

### Where the automation actually lives (honest state)

The submit wiring is **not on main**. Only `bdc3551` (#110, EAS Build project
config) is merged; the ASC wiring exists on unmerged `ship-it/*` branches and
an uncommitted working tree:

| SHA       | Issue | What it adds                                      | Branch                     |
| --------- | ----- | ------------------------------------------------- | -------------------------- |
| `f5dfe01` | #111  | Provision Apple signing credentials               | `ship-it/111-*` (unmerged) |
| `bed47e4` | #112  | ASC app record                                    | `ship-it/112-*` (unmerged) |
| `b352ce1` | #113  | Wire `eas submit` to TestFlight + `testflight.md` | `ship-it/113-*` (unmerged) |
| `573e15a` | #115  | Placeholder ASC listing copy                      | `ship-it/115-*` (unmerged) |

On main (`bdc3551`), `submit.production` is an empty object. The real ASC
submit block sits in the **uncommitted working tree** of
`apps/mobile/eas.json` (real key id/issuer/app id, `.p8` path), and a root
`eas.json` (untracked) carries placeholder `PATRICK_APPLE_ID_PLACEHOLDER`
values. The ASC API key file `apps/mobile/AuthKey_YA86X5XVAT.p8` is present
locally but gitignored (`*.p8`, `.gitignore`). There is **no `.github/`
directory and no CI workflow** — playlift ADR-0001 records "there is still no
CI/macOS runner in this repo"; the EAS pipeline is local-run only.

### Human-gated steps and why

- **Apple Developer Program enrollment** — an account-level, paid ($99/yr)
  step no automation can do.
- **Apple signing credentials provisioned by a human (#111)** — the Developer
  ID / distribution certificate and its `.p8` key pair must be created in the
  Apple portal by a person.
- **App Store Connect app record created manually (#112)** — ASC does not
  auto-create an app record; someone creates it in ASC first.
- **ASC API key generated and downloaded once** — the key is created with App
  Manager access in ASC → Users and Access → Integrations, and the `.p8` file
  "can only download it once" (`testflight.md` prerequisites), so the download
  is a one-time irreversible human act.
- **`eas login` / `eas init` run once locally** — `testflight.md` explicitly
  leaves the `extra.eas.projectId` write to "not committed until Patrick runs
  it".
- **ASC listing metadata (#115)** — App Store Connect requires a support URL,
  privacy policy URL, and primary category before it accepts a build "even
  for internal-only TestFlight distribution" (`573e15a` commit message);
  placeholder copy was committed under `docs/app-store/` for a human to paste
  into ASC.
- **Every build is kicked off by a human** — `npm run submit:ios` is run by a
  person; there is no CI trigger.

### Patterns observed

- **Credential handoff** — the `.p8` never enters git (`*.p8` gitignored);
  the committed-on-branch submit profile references `ASC_API_KEY_PATH` /
  `ASC_API_KEY_ISSUER_ID` / `ASC_API_KEY_ID` env vars (`testflight.md`
  "Required environment variables"), with the explicit instruction "Never
  commit the `.p8` file or these values."
- **Plan-then-approve** — one-time prerequisites are _documented first_
  (`testflight.md`), and the human executes them before automation is run;
  `ascAppId` is noted as **not** injectable via env var, so a non-interactive
  submit must deliberately add it to `eas.json` (`testflight.md`
  "Non-interactive / CI note").

## sound-buddy — Developer ID signing + `notarytool` notarization

### What is automated

`docs/signing-and-notarization.md` documents a one-time human setup (below);
once complete, `scripts/release.sh` builds a signed, notarized, stapled,
Gatekeeper-accepted release **automatically** (signing-and-notarization.md:5-6,
signing-and-notarization.md:91-122).

`scripts/release.sh` is a **two-phase, resumable release**:

- **Phase A (build + verify)** mutates nothing outward-facing — it bumps the
  version, runs the quality gate (build/lint/test, `release.sh:192-196`),
  builds the self-contained `.app`/`.dmg` with `npm run dist`, and verifies
  the result: `codesign --verify --deep --strict`, `xcrun stapler validate`
  on app and dmg, `spctl --assess` on both (release.sh:316-361). The header
  states the contract: "Phase A (build + verify) does not mutate anything
  outward-facing" (release.sh:10-11).
- **Phase B (publish)** stages a GitHub **draft** release first (a draft is
  never `releases/latest`, so update discovery keeps serving the previous good
  release), uploads the zip, dmg, `latest-mac.yml`, and `latest.json`, then a
  final `promote` step flips `draft=false` (release.sh:498-527,
  release.sh:623-639). Every Phase B step before `promote` is idempotent and
  safe to retry — a failed run prints the exact resume command
  (`release.sh $NEXT --yes`) and re-running converges instead of
  double-publishing (release.sh:16-21).

Signing is env-driven with a both-or-neither rule: set
`SOUND_BUDDY_SIGNING_IDENTITY` + `SOUND_BUDDY_NOTARY_PROFILE` for a signed
build, leave both unset for unsigned (release.sh:198-212); the rule is
enforced and validated in `packages/shared` (`resolveSigningConfig`).

### Human-gated steps and why

- **Apple Developer Program enrollment ($99/yr)** — account-level, one-time
  (signing-and-notarization.md:10-11).
- **Developer ID Application certificate creation** — a human creates it in
  Xcode/Apple portal and confirms it in the keychain
  (signing-and-notarization.md:13-20).
- **App-specific password creation + `notarytool store-credentials`** — a
  human creates the app-specific password at appleid.apple.com and stores it
  in the keychain (never in a repo file) (signing-and-notarization.md:22-31).
- **Pushing the `v*` tag or clicking `workflow_dispatch`** — kicks the CI
  `Release` workflow (release.yml:20-25).
- **Release confirmation prompt** — `scripts/release.sh` stops and asks
  "Release <tag> to <repo>? [y/N]" before any publish, unless `--yes`
  (release.sh:271-275).
- **Manual smoke check before announcing** — after release, a human runs
  `npm run smoke:release -- vX.Y.Z`, a live-network, tag-pinned operator
  command that is **not** in CI; it proves the manifest, artifact,
  site-route, and app-update layers all resolve (README.md:107-128).

### What the CI workflow automates (and its fails-closed guardrails)

`.github/workflows/release.yml` mirrors the local flow on a fresh runner:

- Five secrets: `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_ID`,
  `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (release.yml:27-33).
- A "Verify signing secrets" step runs with **no `if:`**, so CI "must never
  produce an unsigned artifact" and "fails the job before any build work if a
  secret is absent" (release.yml:65-69).
- The certificate is imported into a **temporary, randomly-named keychain**
  that is deleted at the end of the job **even on failure** (`if: always()`
  delete step, release.yml:71-89 and release.yml:184-192); the login keychain
  is never touched.
- A fresh runner has no stored `notarytool` keychain profile, so CI
  authenticates notarization with `--apple-id`/`--team-id`/`--password`
  instead of `--keychain-profile` (signing-and-notarization.md:45-54,
  release.yml:104).
- Publishing to the public download repo only happens when a
  `RELEASES_TOKEN` secret (fine-grained PAT, `contents: write` on
  `on-par/sound-buddy-releases`) is configured; otherwise the job still
  builds and uploads a workflow artifact (release.yml:6-8, release.yml:165-182).

### The site: Cloudflare Workers

The landing site deploys to Cloudflare Workers via **Workers Builds**,
configured in the Cloudflare dashboard — `site/wrangler.jsonc` documents:
"root directory = site/, build = `npm ci && npm run build`, Node 22"
(wrangler.jsonc:3-5); the file only drives the `wrangler deploy` step
(wrangler.jsonc:6). The `/download` route is resolved by the Worker from the
stable `latest.json` manifest rather than served as a static asset (#502,
wrangler.jsonc:7-8). The site job in `ci.yml` **builds but does not deploy**
— `npm run verify` (astro check + build + link smoke) with no deploy step
(ci.yml:183-211); deploy is dashboard-configured, not CI-driven.

### Patterns observed

- **Credential handoff** — five CI secrets; a throwaway keychain with
  guaranteed cleanup; the local script uses `gh auth status` and **no stored
  tokens** ("No stored tokens, no CI secret — it uses your local `gh` auth",
  release.sh:5, release.sh:70-71); `RELEASES_TOKEN` is a fine-grained PAT
  scoped to exactly one public repo.
- **Plan-then-approve** — preflight gating (missing tools, dirty tree, `gh`
  auth, reachable public repo all fail before any build, release.sh:66-190);
  a two-phase resumable flow where Phase A changes nothing; draft-then-promote
  so a bad release never becomes `releases/latest`; a confirmation prompt; a
  fail-closed "Verify signing secrets" gate; and a post-publish smoke check
  that is deliberately a manual operator step.
- **Cost/distribution** — release distribution rides GitHub Releases and
  Cloudflare's free tier rather than self-hosted artifact infrastructure.

## launchblitz — Vercel

### What is automated

`docs/deployment.md` defines the MVP production stack: **Vercel** for
`apps/web` (Next.js), Neon/Supabase Postgres, Clerk auth, Stripe billing
(deployment.md:5-12). The deployment contract is a documented checklist plus
Vercel's own git-integration mechanics: connect the GitHub repo, set root
directory `apps/web`, add the enumerated env vars (`NEXT_PUBLIC_APP_URL`,
`DATABASE_URL`, Clerk and Stripe keys, AI-provider keys —
deployment.md:30-57), and Vercel builds on push (install `npm install`, build
`npm run build`, deployment.md:22-26). Once connected, each push to the
linked branch produces a preview deploy automatically.

### Human-gated steps and why

The MVP flow is an explicit **manual checklist** (deployment.md:82-93):

1. Push the repo to GitHub.
2. Connect the repo to Vercel — **Vercel project creation is a one-time
   human action** in the Vercel dashboard.
3. Set the root directory to `apps/web`.
4. Add environment variables — **a human enters each env var**; these are
   account/tier-credentials (Clerk, Stripe, DB) not derivable from the repo.
5. Deploy to a preview URL; verify `/` and `/builds` load with no TS errors.
6. **Promote to production** once stable — **production promotion is a
   human decision**, not an automatic flow.

### Patterns observed

- **Credential handoff** — a written inventory of every required env var and
  where it comes from (deployment.md:30-57), the pattern a provisioning
  design would turn into secret wiring.
- **Cost awareness** — an explicit **deferral list**: "Do not block the MVP
  on" Daytona/per-build sandbox infrastructure, GitHub export automation,
  artifact object storage, or background orchestration (deployment.md:95-104).
  The decision to postpone paid infra until the MVP is validated is itself a
  cost pattern, recorded in the doc rather than re-litigated per deploy.

## software-factory (this repo) — the factory's own deployment automation

### What is automated

- **launchd LaunchAgent merge-sweeper.** `scripts/launchd/com.on-par.auto-merge-sweep.plist`
  is a LaunchAgent (RunAtLoad, KeepAlive, ThrottleInterval 30,
  plist:26-31) running `scripts/auto-merge-sweep.sh`, which lands any open,
  non-draft, mergeable PR whose CI checks are ALL green across the default
  repos `sound-buddy software-factory launchblitz` (auto-merge-sweep.sh:40),
  and uses `factory land` for PRs that close exactly one issue. It has a
  heartbeat health-check convention: `~/.factory/auto-merge-sweep.heartbeat`
  is written at the end of every completed pass and "older than 10 minutes
  means the sweeper is stuck or dead" (plist:10-11, auto-merge-sweep.sh:123-126),
  plus exponential backoff up to 3600s on sweep-wide failure
  (auto-merge-sweep.sh:137-163).
- **Sibling operator scripts** (outside this repo, at
  `/Users/moltbot/repos/on-par/`): `factory-relaunch.sh` (re-pin the PLAN
  model and relaunch a run, dropping already-closed issues),
  `factory-watchdog.sh` (an OpenClaw cron trigger that fires an event exactly
  when a factory run stops — `drained` vs `stuck`), and `factory-keepalive.sh`
  (restart-on-death keepalive polling every 300s). A one-shot, sentinel-armed
  `relaunch-if-dead.sh` also lives in the sibling checkout's
  `.factory/` state dir, run by cron every 10 minutes.
- **Cost KPIs.** The factory tracks per-merge cost as a first-class KPI:
  ADR-0020 ("Cost KPIs are scored on cost-bearing cohorts, and absent cost
  data is unknown, never zero"), with `.factory/costs.jsonl` and
  `.factory/kpi-history.jsonl` resolved in
  `packages/core/src/config/index.ts:388-391`, and per-model
  `costPerMtokInput`/`costPerMtokOutput` fields in
  `packages/config/src/models.json`.

### Human-gated steps and why

- **Installing the LaunchAgent** — install is a manual step:
  `cp scripts/launchd/com.on-par.auto-merge-sweep.plist ~/Library/LaunchAgents/`
  then `launchctl bootstrap gui/$(id -u) ...` (plist:5-9). The plist also
  embeds the operator's absolute checkout path and a version-pinned nvm node
  bin dir that must be hand-updated after any `nvm install`
  (plist:12-15) — automation that still needs a human to maintain its own
  bootstrap.
- **The merge-sweep itself is the point of autonomy** — unlike the other
  pipelines, this one has _no_ human gate on the daily merge action: green
  PRs merge unattended, and a human steps in only to debug a stuck sweeper
  (via the heartbeat) or handle PRs that close multiple issues, which are
  deliberately skipped for manual landing (auto-merge-sweep.sh:93-95).

## mckinnis-edit-site — gh-pages force-push

### What is automated

`deploy.sh` publishes the site to GitHub Pages: it checks `dist/` exists,
copies it into a throwaway temp clone, initializes git on the `gh-pages`
branch, commits, and **force-pushes** to `gh-pages` (deploy.sh:1-27). The
only automation is the push mechanics itself — the script's header states
the constraint: "No GitHub Actions (token lacks `workflow` scope)"
(deploy.sh:2), so the whole flow is run from the developer's machine.

### Human-gated steps and why

- **Every step is manual** — a human runs `npm run build` then
  `npm run deploy` (package.json:9). There is no scheduler, no CI trigger,
  and no confirmation gate; the deploy is a direct force-push the operator
  invokes.
- **Why no CI**: the deployment token in play lacks the `workflow` scope that
  GitHub Actions would need to write the `gh-pages` branch — a credential-
  scope constraint, not a product decision.

## Proven patterns across the audited pipelines

The three patterns the issue names, each with evidence from the pipelines
above.

### Credential handoff

Secrets travel from a human's one-time setup into the pipeline without being
committed, and stay scoped:

- **playlift** — the ASC `.p8` is gitignored (`*.p8`); the submit profile on
  the unmerged branch reads `ASC_API_KEY_*` env vars; `testflight.md`
  instructs "Never commit the `.p8` file or these values."
- **sound-buddy** — five CI secrets; the certificate goes into a temporary
  keychain deleted even on failure; the local release uses `gh auth status`
  with **no stored tokens**; `RELEASES_TOKEN` is a fine-grained PAT scoped to
  a single public repo.
- **launchblitz** — a written env-var inventory is the handoff contract.
- **mckinnis-edit-site** — the absence of the right token scope is the stated
  reason a pipeline stays local.

### Plan-then-approve

Automation is gated behind deliberate, resumable, reversible steps:

- **sound-buddy** — preflight gating; a two-phase resumable release where
  Phase A changes nothing; **draft-then-promote** so a release never becomes
  `releases/latest` before its artifacts are live and verified; a
  confirmation prompt; a fail-closed "Verify signing secrets" step that stops
  CI before any build work; and a manual post-release smoke check.
- **playlift** — one-time prerequisites documented and executed by a human
  _before_ automation runs, plus an explicit note that `ascAppId` must be
  deliberately added for non-interactive submits.
- **The launchd sweeper** — the factory's one fully-autonomous merge step
  still keeps a human-facing heartbeat and skips multi-issue PRs for manual
  landing.

### Cost awareness

Distribution choices and deferrals are made with cost in mind:

- **software-factory** — cost is a measured KPI, not an afterthought:
  ADR-0020, `.factory/costs.jsonl`, per-model price fields in `models.json`.
- **launchblitz** — paid sandbox/object-storage/background infra is explicitly
  deferred until the MVP proves out (deployment.md:95-104).
- **sound-buddy and playlift** — both distribute through existing platforms
  (App Store/TestFlight, GitHub Releases, Cloudflare free tier) rather than
  building self-hosted distribution infrastructure.

## Recommendation relative to baseline

**No recommendation.** This document is the grounding input to the follow-up
provisioning design story, which is where any AWS/Azure pick gets made. The
audit's finding for that story: each pipeline already contains a working
answer to "who holds the secret, who approves the action, and what it costs" —
the future design should reuse these three patterns rather than re-derive
them. None of the audited automation is changed by this document.

## Sources

All checkouts as of the `Date:` line; all external facts (Apple/App Store
Connect/ASC requirements, Vercel/Cloudflare behavior) are approximate and
volatile and must be re-verified before the follow-up design.

- playlift (`/Users/moltbot/repos/on-par/playlift`):
  - `apps/mobile/eas.json` — build profiles + `submit.production.ios`
    (eas.json:1-29); working tree is **uncommitted-modified** with the real
    ASC submit block; on main (`bdc3551`, #110) `submit.production` is empty.
  - `apps/mobile/AuthKey_YA86X5XVAT.p8` — present locally, gitignored
    (`*.p8`, `.gitignore`).
  - `eas.json` (repo root) — untracked placeholder `PATRICK_APPLE_ID_PLACEHOLDER`.
  - `apps/mobile/docs/testflight.md` + `apps/mobile/package.json`
    (`submit:ios` script) — on unmerged branch `b352ce1` (#113).
  - `docs/app-store/*` (listing/privacy/support placeholder copy) — on
    unmerged branch `573e15a` (#115).
  - `docs/adr/0001-...md` — "there is still no CI/macOS runner in this repo".
  - git SHAs: `bdc3551` on main; `f5dfe01` (#111), `bed47e4` (#112),
    `b352ce1` (#113), `573e15a` (#115) on unmerged `ship-it/*` branches.
- sound-buddy (`/Users/moltbot/repos/on-par/sound-buddy`):
  - `docs/signing-and-notarization.md` (one-time setup, CI secrets, pipeline
    behavior; signing-and-notarization.md:1-183).
  - `scripts/release.sh` (two-phase resumable release; release.sh:1-641).
  - `.github/workflows/release.yml` (tag-triggered signed+notarized CI
    release; release.yml:1-192).
  - `site/wrangler.jsonc` (Cloudflare Workers / Workers Builds config;
    wrangler.jsonc:1-19); `ci.yml` site job builds but does not deploy
    (ci.yml:183-211).
  - `README.md` — `npm run smoke:release -- vX.Y.Z` manual pre-announce
    smoke check (README.md:107-128).
- launchblitz (`/Users/moltbot/repos/on-par/launchblitz`):
  - `docs/deployment.md` — stack, Vercel setup, env vars, MVP flow, deferrals
    (deployment.md:1-104).
- software-factory (this repo; sibling operator scripts at
  `/Users/moltbot/repos/on-par/`):
  - `scripts/launchd/com.on-par.auto-merge-sweep.plist` (plist:1-44).
  - `scripts/auto-merge-sweep.sh` (auto-merge-sweep.sh:1-168).
  - `factory-relaunch.sh`, `factory-watchdog.sh`, `factory-keepalive.sh` —
    `/Users/moltbot/repos/on-par/`; `.factory/relaunch-if-dead.sh` in the
    sibling factory checkout.
  - `docs/adr/0020-...md` (cost KPIs); `.factory/costs.jsonl` /
    `.factory/kpi-history.jsonl`; `packages/core/src/config/index.ts:388-391`;
    `packages/config/src/models.json` cost fields.
- mckinnis-edit-site (`/Users/moltbot/repos/on-par/mckinnis-edit-site`):
  - `deploy.sh` (deploy.sh:1-27); `package.json` `"deploy": "./deploy.sh"`.
