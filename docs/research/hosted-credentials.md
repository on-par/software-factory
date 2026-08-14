# Credential and secrets handling for a hosted, multi-repo sandbox (Issue #621)

Date: 2026-08-14

## Purpose and scope

This is the #621 discovery artifact for the hosted-credentials track: it
designs how the factory authenticates when its build/check sandboxes run on a
hosted, potentially multi-repo or multi-owner host instead of one person's
laptop. It compares the two ways to mint scoped, short-lived GitHub tokens per
run (**GitHub App installation tokens** vs. **fine-grained PATs**), designs how
Anthropic/model API keys get injected into an ephemeral sandbox without living
in its filesystem or image, and addresses what changes when one host runs
sandboxes for more than one repo/owner concurrently. It is sequenced after
**#618**'s posture audit (`docs/research/sandbox-posture-audit.md`) and runs in
parallel with **#619** (`docs/research/sandbox-tech-comparison.md`) and **#620**
(`docs/research/hosting-comparison.md`). It is a **discovery artifact, not a
design**: like the siblings it recommends a direction **relative to today's
baseline**, makes no final GitHub-App-vs-PAT pick, and adds no ADR — the
operational pick belongs to a follow-up implementation story, and this document
is that story's design input. Every claim about the current codebase is grounded
in a `file:line` citation to this checkout; the external GitHub facts are
labeled approximate/volatile as of the `Date:` line.

## Today's credential surface

### GitHub: one person's PAT riding the host

`getOctokit()` reads a single global token off the host env and falls back to
`gh`'s stored login:

- `getOctokit()` at `packages/cli/src/cli/index.ts:203-212` reads a single
  `token` from `process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN`
  (index.ts:204); if unset it shells out to `gh auth token` (index.ts:205-209)
  — either way it is one human's credential, not a per-run token — and
  constructs `new Octokit({ auth: token })` (index.ts:211).
- `hasGitHubToken()` at index.ts:222-230 applies the same env-first,
  `gh auth token` fallback logic.
- One octokit instance is created per `shipIssue` run at index.ts:894 and
  threaded into every phase: `planPhase` (index.ts:1093-1114),
  `buildPhase` (index.ts:1146), `checkPhase` (index.ts:1189),
  `shipPhase` (index.ts:1260). The same token therefore covers PLAN's reads and
  BUILD/CHECK/SHIP's write/merge writes.

Merge is a second use of the same credential: `gh pr merge ... --admin` runs at
index.ts:2388, gated by `adminMerge = process.env.FACTORY_MERGE_ADMIN === '1'`
(index.ts:2544), enabled by the `merge` block in
`packages/config/src/factory.json:18-21`. `--admin` requires an admin-capable
token, so the merge path is a host-wide env flag today, not a per-run scoped
decision.

`git push` from the per-issue worktrees uses yet a third path: `shipPhase` runs
`git push origin <branch>` at `packages/core/src/phases/ship.ts:93` and
`git push -u origin <branch>` at ship.ts:132, both with `{ cwd: worktree }` and
no token plumbing — the push authenticates through the git credential helper the
host/worktree inherits (env, `~/.git-credentials`, or keychain), not through the
octokit token. The worktrees themselves are created by `gitFetch`/`setupWorktree`
(`packages/core/src/utils/index.ts:85-93`).

The gc scrubber already acknowledges the credential surface: it treats
`.git-credentials` and `.npmrc` as credential files to zero-fill before deleting
a worktree (`CREDENTIAL_BASENAMES` at `packages/core/src/utils/worktree-gc.ts:42`,
`findCredentialFiles` at worktree-gc.ts:77) — the same files a per-run git token
must not be allowed to plant.

### Model keys: the whole host env rides into every subprocess

- Per-model `envKey` in `packages/config/src/models.json` (e.g.
  `OPENAI_API_KEY` at models.json:112, `DEEPSEEK_API_KEY` at models.json:220);
  the Claude harness's `selfAuth` probe declares
  `defaultEnvKey: 'ANTHROPIC_API_KEY'` (`packages/core/src/harness/catalog.ts:39`).
- The Claude CLI's own subscription OAuth credential is stored on the host in
  `~/.claude/.credentials.json` (`DEFAULT_CREDENTIALS_PATH`,
  `packages/core/src/usage/subscription.ts:27`) and, on darwin, in the macOS
  keychain via `security find-generic-password -s 'Claude Code-credentials'`
  (subscription.ts:29-34); `readClaudeAccessToken` reads the keychain first on
  darwin (subscription.ts:59-66) and falls back to the credentials file
  (subscription.ts:68-74).
- Harness children get the **entire parent env**: exec merges
  `{ ...process.env, ...opts.env }` at `packages/core/src/utils/exec.ts:57`
  (detached spawn) and exec.ts:141 (default exec). The only selective injection
  today is `laneEnv` — the PORT/headless contract — via the `HarnessRequest.env`
  seam (`packages/core/src/harness/index.ts:45-46`), built at
  `packages/core/src/environment/index.ts:317-323` and used at
  `packages/core/src/phases/build.ts:151` and check.ts:206 / check.ts:377.

### The #618 posture this must close against

Per the audit (`docs/research/sandbox-posture-audit.md`): the sandbox inherits
the host env and home directory, and `resolveSandboxPolicy` puts `~/.claude`,
`~/.codex`, `~/.npm`, `~/.cache`, `~/.config`, `~/.local`, and tmp in
`writablePaths` (`packages/core/src/sandbox/index.ts:82-95`); egress is only
ever denied when `network.allow` is empty (sandbox/index.ts:114 for Seatbelt,
sandbox/index.ts:138 for firejail — and the shipped default is a **non-empty**
allowlist, `packages/config/src/factory.json:59`); PLAN runs unwrapped
(`cli/index.ts:1093-1113`, no sandbox option, unlike build at index.ts:1160 and
check at index.ts:1200); and the enforcement signal is currently noise, not
evidence. Consequence stated plainly: with egress open and the whole host env +
home writable/readable, any run can exfiltrate the one GitHub PAT, every model
key, and the Claude OAuth credential. This document does not re-derive those
findings — it designs against them.

## Per-run minting of scoped, short-lived GitHub tokens

### Mechanism A — GitHub App installation tokens

Minting is a two-step server-side operation performed by the host, **never** the
sandbox: (1) sign a short-lived JSON Web Token with the App's private key; (2)
`POST /app/installations/{installation_id}/access_tokens` with that JWT as
`Authorization: Bearer` (GitHub official docs, see Sources). Properties that
matter for this factory:

- **Short-lived**: the returned installation access token expires after **~1
  hour** (GitHub docs) — roughly the span of a single PLAN or BUILD phase under
  the `factory.json` timeouts (`plan_seconds: 1800`, `build_seconds: 7200`,
  `factory.json:11-17`), so one mint per phase is the natural cadence.
- **Per-repo scoping**: the mint call accepts `repositories`/`repository_ids`
  (up to 500) and `permissions` body params, so a token can be limited to
  exactly the one repo a lane works in, with exactly the permission set that
  phase needs (contents read for PLAN, contents write + pull_requests for
  BUILD/CHECK, and contents + pull_requests + administration/merge for SHIP).
- **Revocable**: suspending/uninstalling the App kills every token it minted
  instantly — no hunting through a settings page.
- **Consumed exactly where today's PAT is**: as `GITHUB_TOKEN`/`GH_TOKEN` for
  octokit (index.ts:204) and for `git push` via the per-run git credential
  scoping described below.
- The private key itself lives on the host, out of the sandbox, and is the only
  long-lived secret involved.

The git path is the one seam to design explicitly: today's `git push` rides the
host credential helper (ship.ts:93, ship.ts:132). For a per-run installation
token the git auth is `https://x-access-token:<TOKEN>@github.com/<owner>/<repo>`
(GitHub docs) — injected per-run as `http.extraHeader`
(`Authorization: token <TOKEN>`) scoped to the one remote, or via a per-run
`GIT_ASKPASS`/credential-helper that only answers for that repo, so no
`.git-credentials` file is ever planted in the worktree.

### Mechanism B — fine-grained PATs

GitHub's "more secure than classic" per-user token (GitHub docs, see Sources):

- **Bound to a user account** — each token is limited to resources owned by a
  single user or organization, with per-repo repository selection and
  fine-grained permissions.
- **Not per-run fresh**: expiration is set at mint time with a **minimum of 1
  day** (`expires_in` 1–366 or none), so a token cannot have per-run TTL; a
  minted token outlives the run that used it.
- **Minted by a human, not automatically per-run**: fine-grained PATs are
  created through the user's Developer settings UI/API, not by a service —
  there is no per-(run, repo, permission-set) mint endpoint like the App
  mechanism's.
- **Awkward to revoke mid-run**: revocation is a settings-page action on the
  specific token, and there is no instant "suspend the app" kill switch.
- **Blast radius includes every repo the PAT grants**: a leaked per-repo PAT
  still authenticates as that user to every repo and org the user belongs to,
  and one token cannot cover multiple organizations at once (a documented
  fine-grained-PAT limitation).

GitHub's own guidance is on point for this factory's direction: "If you require
more tokens or are building automations, consider using a GitHub App for better
scalability and management" (GitHub docs).

### Recommendation direction (operational pick deferred)

**GitHub App installation tokens as the per-run mechanism**: one App install per
owner, one token minted per (run, repo) with the minimum permissions for the
phase, delivered to the run only via env (`GH_TOKEN`) plus per-run git credential
scoping — replacing the single global PAT at index.ts:204 and the `--admin`
merge ride at index.ts:2388. **Fine-grained PATs remain the bootstrap/fallback**
for owners/repos that cannot be App-controlled (a new owner mid-onboarding, a
repo whose org blocks GitHub Apps), where their 1-day minimum TTL and
human-minting flow are accepted as a transition cost. The final pick — including
whether the broker mints installation tokens directly or via a hosted App
management service — is deferred to the implementation story, mirroring #619's
deferral of its pick to #622 and #620's deferral of the hosting pick.

## Injecting Anthropic/model API keys into an ephemeral sandbox

Framed against #618: an env var is still exfiltratable over **open egress**
(sandbox-posture-audit.md: a non-empty allowlist is never enforced without a
proxy, sandbox/index.ts:114/138 vs. the shipped `factory.json:59` allowlist), so
key scoping and egress enforcement are **paired, not alternatives** — any
injection mechanism below still expects the follow-up sandbox story to close
egress. Three mechanisms, grounded in today's seams:

**(a) Env injection at spawn.** Extend the existing selective-env mechanism —
`laneEnv` (`packages/core/src/environment/index.ts:317-323`) already injects a
small computed env into build/check/rework runs via the `HarnessRequest.env`
seam (`packages/core/src/harness/index.ts:45-46`, consumed at build.ts:151 and
check.ts:206/377) — into a filtered per-run secret env. The broker hands the
phase a `secretEnv` map of exactly the keys the routed model needs; the harness
replaces the `{ ...process.env, ...opts.env }` merge at
`packages/core/src/utils/exec.ts:57/141` with a **replace-or-filtered** merge for
sandboxed runs so `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`DEEPSEEK_API_KEY`, etc. enter the sandbox only as process env of the single
spawned run. Never written to disk and never baked into the image. This is the
cheapest mechanism and the one that plugs into today's code with the least new
machinery.

**(b) Host-side outbound relay/proxy.** The key never crosses into the sandbox
at all: a relay on the host adds the `Authorization` header outside the sandbox
boundary and forwards the (key-less) request from inside. This aligns with #618's
observation that egress can only be enforced via a proxy (sandbox/index.ts:5-8)
and with the existing config seams for a proxy shape — `sandbox.network.allow`
(`factory.json:59`) and the loopback `environment.proxy`
(`factory.json:93-98`). Strongest guarantee for the model-key itself, but it
only covers outbound model traffic; the GitHub token still needs (a) or a
git-side relay.

**(c) Secret files on tmpfs, 0400, unlink-after-read.** Explicitly NOT in the
image and NOT in `writablePaths` (`sandbox/index.ts:82-95`): a host-side tmpfs
file mounted read-only into the sandbox (or written after the profile is built),
chmod 0400, read once by the harness to populate the child env, then unlinked.
It does not persist in the image or worktree, but it is still a file a
compromised agent with egress can read before it is unlinked — so this is the
fallback for CLIs that insist on a file (e.g. `~/.claude/.credentials.json`
shaped secrets), not the primary mechanism.

**The Claude CLI subscription-auth case is the sharp corner.** Today's Claude
auth is the OAuth credential in `~/.claude/.credentials.json` and the macOS
keychain (`packages/core/src/usage/subscription.ts:27-34`), and `~/.claude` is
explicitly **writable** by the sandbox (`sandbox/index.ts:86`). A compromised
run can read, replace, or exfiltrate that stored subscription credential even
after we stop injecting `ANTHROPIC_API_KEY`. The design must (1) replace it with
a per-run injected key or a scoped relay for Claude-routed builds, and (2) drop
`~/.claude` and `~/.codex` from `writablePaths` whenever the run does not need
them — which the #619/#622 sandbox work can make the default, since per-run keys
make the stored OAuth login unnecessary in the sandbox.

## Concurrent multi-repo / multi-owner on a shared host

**Per-run token scoping is the security boundary, not the sandbox.** On a
shared host running lanes for several owners/repos concurrently, a compromised
lane can only reach the single repo its minted installation token grants — its
mint call's `repository_ids`/`permissions` (Section 3) bound it by construction.
That closes the #618 credential-exfiltration blast radius (the one global PAT at
index.ts:204 covering every repo) **even while egress stays open**, which matters
because #619/#620 defer egress enforcement to follow-ups.

**Host-side credential broker design.** One service on the host owns the
long-lived secrets — the GitHub App private keys (one per owner), the App/owner
registration, and the model-key pool — and grants per-run scoped secrets keyed
by (lane, issue, owner, repo, phase):

- Before each phase the supervisor requests a grant instead of inheriting
  `process.env` wholesale; the broker mints an installation token scoped to that
  repo with the phase's minimum permissions and returns a `secretEnv` (mechanism
  (a)) or a relay route (mechanism (b)) for the model key.
- The broker is where the private keys live; the sandbox never sees them, and no
  credential is copied into the sandbox's image or writable paths.
- Grants are logged per (lane, run, phase) so costs stay attributable — ADR-0020
  (`docs/adr/0020-cost-kpis-are-scored-on-cost-bearing-cohorts-and-absent-cost-data-is-unknown-never-zero.md`)
  scores cost on cost-bearing cohorts, and per-run attribution still works if
  the broker's grant log says which grant served which run.

**What changes vs. today, itemized:**

1. **The single global PAT goes away.** `getOctokit()` (index.ts:203-212) is
   replaced by per-phase minted tokens; `hasGitHubToken()` (index.ts:222-230)
   and the `gh auth token` fallback become bootstrap-only.
2. **The single global API-key env goes away.** The env merge
   (`{ ...process.env, ...opts.env }`) at
   `packages/core/src/utils/exec.ts:57/141` stops inheriting the full host env
   for sandboxed runs; only broker-granted secrets enter, via
   `HarnessRequest.env` (harness/index.ts:45-46).
3. **`git push` stops riding the host credential helper** (ship.ts:93,
   ship.ts:132): it uses the per-run repo-scoped installation token via
   `http.extraHeader`/`GIT_ASKPASS`, so the worktree never plants or inherits a
   `.git-credentials` (the file the gc scrubber already hunts,
   worktree-gc.ts:42/77).
4. **`FACTORY_MERGE_ADMIN` stops being a host-wide env flag** (index.ts:2544):
   `gh pr merge --admin` (index.ts:2388) becomes a per-run, per-repo decision
   scoped by an admin-capable installation token minted only for the merge
   phase, not a global `=== '1'` switch.
5. **Stored Claude OAuth creds stop riding into sandboxes**: `~/.claude` and
   `~/.codex` leave `writablePaths` (sandbox/index.ts:86-87) by default;
   Claude-routed runs get per-run injected keys instead
   (`subscription.ts:27-34` auth is host-only).

## Sources

All URLs retrieved 2026-08-14. External behavior (token lifetimes, mint
endpoints, fine-grained-PAT limits) is **approximate as of the `Date:` line and
must be re-checked before the implementation story commits to a pick**; GitHub's
docs are the most volatile source here.

- GitHub — authenticating as a GitHub App installation (JWT-signed mint at
  `POST /app/installations/{id}/access_tokens`, 1-hour token lifetime,
  `repositories`/`permissions` body params, git via
  `https://x-access-token:<TOKEN>@github.com/<owner>/<repo>`):
  https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
- GitHub — managing your personal access tokens (fine-grained PATs bound to one
  user/org, per-repo selection, `expires_in` 1–366 days or none, human-minted in
  Developer settings, the "consider using a GitHub App for automations" guidance,
  and the single-org limitation):
  https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- Repo grounding — `packages/cli/src/cli/index.ts` (getOctokit, phase threading,
  `--admin` merge), `packages/core/src/phases/ship.ts` (git push),
  `packages/core/src/utils/exec.ts` and `environment/index.ts` (env inheritance /
  laneEnv), `packages/core/src/utils/worktree-gc.ts` (credential scrub),
  `packages/core/src/usage/subscription.ts` (Claude OAuth),
  `packages/core/src/sandbox/index.ts` (writablePaths / egress),
  `packages/config/src/factory.json` (merge block, network allowlist, proxy seam),
  `packages/config/src/models.json` and `packages/core/src/harness/catalog.ts`
  (model envKey / `ANTHROPIC_API_KEY`), ADR-0020, and the sequencing docs
  `docs/research/sandbox-posture-audit.md` (#618),
  `docs/research/sandbox-tech-comparison.md` (#619),
  `docs/research/hosting-comparison.md` (#620) — all cited by file:line in the
  body of this document.
