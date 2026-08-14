# AI-provider terms of service for hosted, multi-tenant, bring-your-own-subscription execution (Issue #650)

Date: 2026-08-14

## Purpose and scope

This is the #650 discovery artifact for the hosted-product track. It answers,
per AI provider, whether the hosted Software Factory framing — "an end user logs
into a hosted product with _their own_ AI subscription (Claude Code Max / Claude
Pro, Codex, OpenCode, or similar) and the host executes that subscription on its
shared, multi-tenant VPS on that user's behalf, including programmatically" — is
**permitted**, **prohibited**, or an **unclear** gray area under the vendor's
current, actual terms of service and usage policies. This is a **usage-terms and
billing-model question, not an engineering one**: it is separate from #619-#622
(execution sandboxing, credential scoping), which this issue must gate before
deep investment in the hosted architecture. Every verdict below is reached by
quoting the specific current clauses that drive it — not by general knowledge or
second-hand commentary — and every claim about this checkout is grounded in a
`file:line` citation. Verdicts are a plain-text reading of the quoted documents
as of the `Date:` line; they are **not legal advice**, and the residual gray
areas (Section "Unclear verdicts and next steps") name the specific vendor/legal
action that turns them into real answers.

Sequencing: resolved after **#618**'s posture audit
(`docs/research/sandbox-posture-audit.md`), which it is dependent on, and before
deep engineering investment in the **#619-#622** hosted architecture — the
hosted-series docs it gates are `docs/research/sandbox-tech-comparison.md`
(#619), `docs/research/hosting-comparison.md` (#620),
`docs/research/hosted-credentials.md` (#621),
`docs/research/hosted-sandbox-recommendation.md` (#622), and the two Accepted
hosted-execution decisions, ADR-0023 and ADR-0024. This document is a
**discovery artifact, not a design**: it records findings about external terms
and defers the billing-model pick to the follow-up hosted-product story that
consumes this doc, exactly as #624/#625/#626/#628 deferred their binding picks —
so **no ADR is written here**.

## The scenario being checked

A hosted, multi-tenant Software Factory product where:

1. An end user authenticates with **their own personal AI subscription** —
   Claude Pro / Claude Max (with Claude Code), a ChatGPT plan (with Codex), or an
   OpenCode setup fronting a provider — rather than a provider API key billed to
   the host.
2. The **host executes that subscription** on its shared VPS **on the user's
   behalf**, serving other end users on the same multi-tenant infrastructure.
3. Execution is **programmatic/automated**, not interactive-at-the-user's-keyboard:
   the factory drives the model CLIs non-interactively through its harnesses —
   `claude -p … --output-format json` (`packages/core/src/harness/claude-cli.ts:81`),
   `codex exec --json …` (`packages/core/src/harness/codex-cli.ts:33`), and
   `opencode run --model <provider/model>` (`packages/core/src/harness/opencode.ts:23`).

This is materially different from (a) the factory operator running _their own_
subscription on _their own_ machine — the individual-use pattern today, which is
not in question — and (b) the #619-#622 engineering concerns (sandboxing,
credential scoping), which are out of scope here. The question is only whether
the subscription's _terms_ permit this hosted, multi-tenant, automated
BYO-subscription use.

### The subscription surface this checkout actually uses today

- **Anthropic Claude** — the factory's today path. The `claude-cli` harness
  (`packages/core/src/harness/catalog.ts:39` self-auths for `anthropic` with
  `defaultEnvKey: 'ANTHROPIC_API_KEY'`), and the Claude models are marked "uses
  claude CLI subscription auth, no API key needed" (`packages/config/src/models.json:15`,
  models.json:27, models.json:39, models.json:51). The stored credential is the
  OAuth subscription token in `~/.claude/.credentials.json` / the macOS keychain
  (`DEFAULT_CREDENTIALS_PATH`, `packages/core/src/usage/subscription.ts:27-34`),
  the same auth `claude -p` rides (`claude-cli.ts:81`).
- **OpenAI / Codex** — the codex-cli models are marked "Codex CLI subscription
  auth (ChatGPT/OAuth), not an API key" (`models.json:64`, and the same note at
  models.json:77, models.json:90, models.json:103), routed to the `codex-cli`
  harness by `routes.json:20` (`build_codex`, `requires: codex`), which runs
  `codex exec --json` (`codex-cli.ts:33`).
- **OpenCode** — `opencode-sonnet` (`models.json:239-244`) runs the OpenCode CLI
  via the generic-harness seam (`harness: "opencode"`, `opencode.ts:23`) against
  `providerModel: "anthropic/claude-sonnet-5"` — i.e. OpenCode is a front-end;
  the underlying provider's terms bind.

## Verdict table

One row per provider, labelled per the issue's **permitted / prohibited /
unclear** vocabulary. "BYO-subscription hosted execution" = the scenario above.
The full clause-by-clause argument is in the per-provider sections that follow.

| Provider / subscription (how the factory authenticates today)                                                                | BYO-subscription hosted, multi-tenant, automated execution                                                                                                                                                                                                                                                        | Sanctioned alternative path                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Anthropic Claude** (Claude Pro/Max subscription; `claude-cli` OAuth auth — models.json:15/27/39/51, subscription.ts:27-34) | **Prohibited** — Consumer Terms §2 (may not make your Account available to anyone else), §3(7) (no automated/non-human access except via an Anthropic API key), §3(2) (no reselling the Services)                                                                                                                 | **Permitted** — metered API billed to the host under the Commercial Terms, which explicitly permit powering products/services for end users (§A.1); or a partnership/reseller agreement (D.4)                                  |
| **OpenAI / Codex** (ChatGPT subscription / OAuth auth — models.json:64/77/90/103, routes.json:20)                            | **Prohibited** — Terms of Use (may not share account credentials or make the account available to anyone else; may not lease/sell/distribute the Services; no automatic or programmatic extraction of Output); the OpenAI Services Agreement §3.1 explicitly adds "may not resell or lease access to its Account" | **Permitted** — API key under the OpenAI Services Agreement, which explicitly permits integrating the API into Customer Applications for End Users (§2.2) and which OpenAI's own Codex docs describe as the automation/CI path |
| **OpenCode CLI** (open-source front-end; `opencode-sonnet` fronts Anthropic — models.json:239-244)                           | **n/a as a provider** — its own license is MIT open-source, not a subscription; the underlying provider's terms bind (Anthropic for opencode-sonnet), so the verdict folds into the Anthropic row                                                                                                                 | Folds into the underlying provider row above                                                                                                                                                                                   |

## Anthropic Claude subscriptions

### The current terms

- **Consumer Terms of Service**, effective **2025-10-08**
  (https://www.anthropic.com/legal/consumer-terms). Govern Claude.ai, Claude Pro,
  and other offerings for individuals. The header is explicit about the split:
  "Please note: Our Commercial Terms of Service govern your use of any Anthropic
  API key, the Anthropic Console, or any other Anthropic offerings that reference
  the Commercial Terms of Service."
- **Commercial Terms of Service**, effective **2025-06-17**
  (https://www.anthropic.com/legal/commercial-terms). Govern API keys and other
  business offerings, and open with the mirror-image carve-out: "Services under
  these Terms are not for consumer use. Our consumer offerings (e.g., Claude.ai)
  are governed by our Consumer Terms of Service instead."
- **Usage Policy**, effective **2025-09-15** (https://www.anthropic.com/legal/aup).
  Applies to "anyone who can submit inputs to Anthropic's products and/or
  services, including via any authorized resellers or passthrough access."
- **Service Specific Terms**, effective **2026-06-08**
  (https://www.anthropic.com/legal/service-specific-terms). Cover Claude for Work
  (Team/Enterprise), Beta, Fine-Tuning, Marketplace, Development Partner, and
  Covered Models — none of which create a carve-out for running a consumer
  subscription on a third party's hosted, multi-tenant infrastructure.

### The clauses that drive the verdict

Four clauses of the Consumer Terms bear directly on the scenario:

**(a) Account sharing / making the account available to others.** Consumer
Terms §2: "You may not share your Account login information, Anthropic API key,
or Account credentials with anyone else. You also may not make your Account
available to anyone else. You are responsible for all activity occurring under
your Account." A hosted BYO-subscription flow requires the end user to hand
their Claude OAuth credential to the host (which stores it, per the today seam at
subscription.ts:27-34, and uses it to drive `claude -p`, claude-cli.ts:81), and
for the host to execute it on behalf of other end users on shared infrastructure
— both "share your … Account credentials with anyone else" and "make your
Account available to anyone else" on their face.

**(b) Automated / non-human access.** Consumer Terms §3(7): "Except when you are
accessing our Services via an Anthropic API Key or where we otherwise explicitly
permit it, to access the Services through automated or non-human means, whether
through a bot, script, or otherwise." The factory's Claude execution is exactly
scripted access: `claude -p … < /dev/null` (claude-cli.ts:81) is a script, not a
human at the keyboard, and the OAuth subscription credential is not an API key.
This clause independently prohibits the programmatic-execution angle of the
BYO-subscription scenario — the carve-out is explicitly "via an Anthropic API
Key", which is the Commercial path, not the subscription path.

**(c) Reselling the Services.** Consumer Terms §3(2): "To develop any products
or services that compete with our Services, including to develop or train any
artificial intelligence or machine learning algorithms or models or resell the
Services." A hosted product that charges end users (or otherwise commercially
monetizes) access to Claude drawn from a consumer subscription is reselling the
Services within the plain meaning of this clause.

**(d) The Commercial path's explicit carve-out.** Commercial Terms §A.1:
"Subject to these Terms, Anthropic gives Customer permission to use the
Services, including to power products and services Customer makes available to
its own customers and end users ('Users')." and the header "Services under these
Terms are not for consumer use." The Commercial/API path is the one that
explicitly contemplates powering products for end users; the consumer path is
explicitly excluded from it.

### Application to the hosted BYO-subscription scenario

Applying clauses (a), (b), and (c) to the scenario — a user's own Claude
subscription, run programmatically by a host, on shared multi-tenant VPS
infrastructure, on behalf of other end users — the verdict for the
**consumer-subscription path is `prohibited`**: the current Consumer Terms on
their face forbid sharing/making available the Account, forbid automated access
outside the API-key carve-out, and forbid reselling the Services. The factory's
own Claude usage pattern (`claude -p` via the OAuth credential,
subscription.ts:27-34 / claude-cli.ts:81) is the precise pattern §3(7) carves
out — it is only the subscription that is unauthorized for it, which is why the
same execution pattern is fully sanctioned on the Commercial path (§A.1). This
is the shutdown risk the issue names: getting it wrong is not a bug, it is a
terms breach with account/API suspension as the stated remedy (Consumer Terms §12
termination; Usage Policy enforcement).

The verdict is stated as a reading of the quoted current text, not as a guess,
and the gray areas that remain (whether Anthropic will _approve_ a hosted
BYO-subscription arrangement via "where we otherwise explicitly permit it" or a
partnership/reseller agreement) are treated as the separate **unclear** items in
Section "Unclear verdicts and next steps".

### Alternative billing model and cost implications (Anthropic)

Because the BYO-subscription verdict is prohibited, the doc names the
alternative per the issue: **metered API usage billed by the host under the
Commercial Terms** — the sanctioned "power products and services for end users"
path — or a **vendor partnership/reseller agreement** (which the Commercial
Terms D.4 anticipates: "resell the Services except as expressly approved by
Anthropic").

Cost implications, flat subscription vs. metered API (as of the `Date:` line):

- **Flat subscription (the prohibited path, for the account holder's own local
  use):** Claude Pro $20/mo billed monthly ($17/mo annual), Claude Max from
  $100/mo, Team from $20/seat/mo, Enterprise $20/seat + usage at API rates
  (claude.com/pricing). These are flat per account regardless of issue volume —
  which is precisely why they look attractive — but the hosted multi-tenant
  scenario cannot legally use them.
- **Metered API (the permitted path):** current list rates from claude.com/pricing:
  Opus 5 $5/MTok in / $25/MTok out, Sonnet 5 $2/$10, Fable 5 $10/$50, Haiku 4.5
  $1/$5. Against this checkout's own `costPerMtokInput`/`costPerMtokOutput`
  figures — `claude-opus-5` 5.0/25.0 (models.json:19-21), `claude-sonnet-5`
  3.0/15.0 (models.json:44-46), `claude-fable-5` 8.0/40.0 (models.json:8-9) — the
  house figures are close to but **not identical** to the current list prices
  (Sonnet 5's listed $2/$10 vs. the house 3.0/15.0; Fable 5's listed $10/$50 vs.
  the house 8.0/40.0). A follow-up should refresh models.json's costs when the
  hosted story lands, since ADR-0020 cost KPIs are scored on those figures.
- **Illustrative per-issue arithmetic** (rough, for framing only; the factory
  already tracks real cost KPIs per ADR-0020,
  `docs/adr/0020-cost-kpis-are-scored-on-cost-bearing-cohorts-and-absent-cost-data-is-unknown-never-zero.md`):
  a PLAN→BUILD→CHECK cycle consuming on the order of ~1M input + ~300k output
  tokens across all model calls would cost ~$5 at Sonnet 5 API rates
  (1M×$2 + 0.3M×$10) and ~$12.50 at Opus 5 rates (1M×$5 + 0.3M×$25). Against a
  flat Max subscription at $100/mo that is roughly 8-20 metered issues/mo at
  Opus rates before the flat price looks cheaper — but the flat price is
  unavailable to the hosted scenario, so per-issue metered cost (single digits of
  dollars, dominated by input tokens) is the figure the hosted product must
  price on.

## OpenAI / Codex subscriptions

### The current terms

- **Terms of Use**, effective **2026-01-01** (https://openai.com/policies/terms-of-use/).
  Govern "ChatGPT, DALL·E, and OpenAI's other services for individuals." The
  scope note is explicit: "Our Business Terms govern use of ChatGPT Enterprise,
  our APIs, and our other services for businesses and developers."
- **OpenAI Services Agreement** (the "Business Terms" page; updated **2025-12-01**,
  effective **2026-01-01**) (https://openai.com/policies/business-terms/).
  Governs the API and business/developer services: "This OpenAI Services
  Agreement only applies to use of OpenAI's APIs, ChatGPT Enterprise, ChatGPT
  Business, ChatGPT for Clinicians, and other services for customers who are
  businesses and developers, and does not apply to OpenAI services used by
  consumers or individuals unless specified above."
- **Usage Policies**, effective **2025-10-29**
  (https://openai.com/policies/usage-policies/). Universal policies across
  products; the abuse/evasion and high-stakes-decision rules apply to any access
  but do not change the subscription-vs-API boundary above.
- **Codex product page** (https://openai.com/codex/) and **Codex pricing docs**
  (https://openai.com/codex/pricing): Codex ships "across ChatGPT, your editor,
  and the terminal, all connected by your ChatGPT account"; plans are Free $0,
  Go $8/mo, Plus $20/mo, Pro from $100/mo, Business $20/user/mo; and the API-key
  path is described as "Great for automation in shared environments like CI …
  Pay only for the tokens Codex uses, based on API pricing."

### The clauses that drive the verdict

**(a) Account sharing / making the account available.** Terms of Use,
Registration: "You may not share your account credentials or make your account
available to anyone else and are responsible for all activities that occur under
your account." The BYO-subscription hosted flow requires the end user's ChatGPT
OAuth credential to live on the host (the codex-cli harness authenticates with
that ChatGPT/OAuth subscription auth, models.json:64, and drives `codex exec`
at codex-cli.ts:33) — sharing the credential and making the account available
to the host, on its face.

**(b) Lease, sell, or distribute the Services.** Terms of Use, "What you cannot
do": "Modify, copy, lease, sell or distribute any of our Services." A hosted
product commercially monetizing access drawn from a user's ChatGPT subscription
distributes the Service.

**(c) Automated/programmatic access.** Terms of Use, "What you cannot do":
"Automatically or programmatically extract data or Output (defined below)."
`codex exec --json` (codex-cli.ts:33) is precisely programmatic execution, and
the OpenAI Services Agreement adds the rate-limit mirror: customers may not
"circumvent any rate limits or restrictions or bypass any protective measures"
(§3.3(h)) — a host aggregating many subscriptions onto one ChatGPT account would
hit exactly that. The subscription path does not carry a programmatic carve-out
analogous to the API-key carve-out in Anthropic's §3(7); OpenAI's carve-out is
the API itself, which its own Codex docs call out as the automation/CI path.

**(d) The API/business path's explicit permission.** OpenAI Services Agreement
§2.2: "OpenAI grants Customer a non-exclusive right to access and use the
Services during the Term. This includes the right to use OpenAI's API to
integrate the Services into Customer Applications and to make Customer
Applications available to End Users." — and §3.1's mirror-image prohibition on
the account path: "Customer will not share Account access credentials or
individual login credentials between multiple users. Customer may not resell or
lease access to its Account or any End User Account."

### Application to the hosted BYO-subscription scenario

Applying (a), (b), and (c) to the scenario, the verdict for the
**ChatGPT-subscription path is `prohibited`**: the current Terms of Use on their
face forbid sharing/making available the account, forbid leasing/selling/
distributing the Services, and forbid automatic or programmatic extraction of
Output — and the subscription holder's own model notes in this checkout
("Codex CLI subscription auth (ChatGPT/OAuth), not an API key", models.json:64)
mark the auth as the consumer subscription, not the sanctioned automation
surface. The **API-key path is the sanctioned alternative**: the Services
Agreement explicitly permits integrating the API into Customer Applications for
End Users (§2.2), and OpenAI's own Codex pricing page frames the API key as "for
automation in shared environments like CI" with "Pay only for the tokens Codex
uses" — the exact hosted, programmatic pattern the factory runs.

### Alternative billing model and cost implications (OpenAI / Codex)

- **Flat subscription (the prohibited path, for the account holder's own local
  use):** ChatGPT Plus $20/mo, Pro from $100/mo, Business $20/user/mo (annual),
  with Codex usage limits on message windows per plan (codex pricing docs).
- **Metered API (the permitted path):** pay per token at API pricing. Against
  this checkout's own figures, the gpt-5.6 family is `costPerMtokInput` 1.25 /
  `costPerMtokOutput` 10.0 (`gpt-5.6-sol` models.json:56-57, `gpt-5.1-codex`
  models.json:69-70, `gpt-5.6-terra-high` models.json:83-84, `gpt-5.6-terra-medium`
  models.json:96-97). Using the same illustrative ~1M in / ~300k out per issue,
  a gpt-5.6-terra-medium build runs ~$4.25/issue (1M×$1.25 + 0.3M×$10) — the
  cheapest of the factory's cloud worker rows, consistent with the flat-rate
  economics the routing rule already relies on (`routes.json` codex_available
  note, models.json:300). As with Claude, the metered number is what the hosted
  product prices on; ADR-0020 cost KPIs keep it attributable per run.

## OpenCode

OpenCode is an **open-source CLI** — the "open source coding agent"
(https://github.com/anomalyco/opencode, MIT license, retrieved 2026-08-14) — so
its own license is **not a subscription** and carries no usage-terms verdict of
its own. The terms that bind are the **underlying provider's**: this checkout's
`opencode-sonnet` model fronts `providerModel: "anthropic/claude-sonnet-5"`
(models.json:248), so an OpenCode route authenticating with a provider
subscription is bound by that provider's subscription terms (the Anthropic row
above), and an OpenCode route authenticating with a provider API key is bound by
that provider's commercial/API terms (the permitted alternatives above). The
OpenCode row's verdict therefore **folds into the underlying provider row** —
there is no separate OpenCode subscription to analyze.

## Alternative billing model and cost implications (consolidated)

For both prohibited verdicts the alternative is the same shape, and it is the
path both vendors' own documents describe as sanctioned:

- **Metered API billed by the host under the vendor's commercial/API terms**
  ("power products and services for end users" — Anthropic Commercial Terms
  §A.1; "integrate the Services into Customer Applications … available to End
  Users" — OpenAI Services Agreement §2.2). Per-token cost vs. flat subscription:
  single-digit dollars per factory issue at the illustrative token volume above
  (≈$5/issue Sonnet 5, ≈$12.50/issue Opus 5, ≈$4.25/issue gpt-5.6-terra-medium),
  versus the flat $20/mo (Pro/Plus) or $100/mo (Max/Pro) subscription — which is
  only cheaper once a single account's local volume exceeds several issues a
  month, and which the hosted scenario cannot legally use anyway.
- **Vendor partnership/reseller agreement** where the host wants subscription-
  or commit-based economics (Anthropic Commercial Terms D.4's "except as
  expressly approved by Anthropic"; OpenAI's Enterprise/reseller path) — a
  sales negotiation, not a self-serve pick.

The factory already tracks per-run cost through its cost KPIs (ADR-0020), so the
metered path slots into the existing `cost_tracking` accounting
(`packages/config/src/factory.json:40-44`); the one housekeeping item a
follow-up should do is refresh `models.json` `costPerMtokInput`/`costPerMtokOutput`
for claude-sonnet-5 (3.0/15.0 house vs. $2/$10 list) and claude-fable-5 (8.0/40.0
house vs. $10/$50 list), since ADR-0020 scores on those figures.

## Unclear verdicts and next steps

The primary verdicts are `prohibited` (not unclear) because the current texts
are explicit. The genuinely **unclear** residual items, and the specific action
that turns each into a real answer:

- **Unclear — can the vendor approve a hosted BYO-subscription flow?** Anthropic
  Consumer Terms §3(7) leaves an "or where we otherwise explicitly permit it"
  carve-out, and Commercial Terms D.4 leaves "resell the Services except as
  expressly approved by Anthropic"; OpenAI's Services Agreement likewise carves
  out reseller arrangements. Whether either vendor will approve a hosted,
  multi-tenant BYO-subscription arrangement is an open question that only they
  can answer. **Next step:** email Anthropic via the commercial-terms notice
  path (notices@anthropic.com, Commercial Terms §M.1) and OpenAI via its sales
  path (openai.com/contact-sales), asking specifically whether executing a
  user's Claude/ChatGPT subscription programmatically on a hosted, multi-tenant
  service on behalf of other end users is permitted or can be approved — not a
  guess about whether the prohibition applies, but a request for the approval
  the texts reserve.
- **Unclear — the exact boundary of the consumer-subscription prohibitions.** The
  clauses quoted are explicit, but their reach in edge configurations (e.g. a
  user's own subscription driven only for that user's own requests, on
  single-tenant-per-user infrastructure, with no programmatic access) is a
  legal-reading question. **Next step:** external legal review of the quoted
  clauses (Anthropic Consumer Terms §2 and §3(2)/(7); OpenAI Terms of Use
  Registration / "What you cannot do"; OpenAI Services Agreement §3.1) against
  the exact intended hosted configuration, before the hosted-product story
  commits to a billing model.
- **Unclear — reseller/partnership economics.** Whether a vendor partnership or
  reseller agreement exists that makes BYO-subscription or commit-based hosting
  viable (and at what economics) is a sales question. **Next step:** the same
  vendor contacts above, asking for the partnership/reseller path and its
  pricing, before treating metered API as the only option.

None of these are a guess: each names the vendor/legal action that produces a
real answer, matching the issue's acceptance criterion.

## Sequencing note

This document is sequenced **after #618** (the posture audit,
`docs/research/sandbox-posture-audit.md`) and **before deep engineering
investment in the #619-#622 hosted architecture**
(`docs/research/sandbox-tech-comparison.md`, `hosting-comparison.md`,
`hosted-credentials.md`, `hosted-sandbox-recommendation.md`, and ADR-0023 /
ADR-0024). Its finding — consumer AI subscriptions are prohibited for hosted,
multi-tenant, automated BYO-subscription execution, and the metered API path is
the sanctioned alternative — is exactly the gate the issue intends: the hosted
product must be priced and built on the metered/commercial path (or a negotiated
reseller arrangement), not on end users' personal subscriptions, and that is
now a documented decision input for the follow-up story rather than an
unexamined assumption.

## Sources

All URLs retrieved **2026-08-14**. External terms are **volatile and must be
re-checked against the live pages before the hosted-product story commits** to a
billing model; the effective dates below are the versions quoted in this
document.

- Anthropic — Consumer Terms of Service (eff. **2025-10-08**): §2 account
  sharing / making the Account available; §3(2) reselling the Services; §3(7)
  automated/non-human access except via an Anthropic API key; §12 termination;
  the Commercial-vs-consumer header note: https://www.anthropic.com/legal/consumer-terms
- Anthropic — Commercial Terms of Service (eff. **2025-06-17**): header
  "Services under these Terms are not for consumer use"; §A.1 permission to
  power products/services for end users; D.4 resale "except as expressly approved
  by Anthropic"; §M.1 notice path (notices@anthropic.com):
  https://www.anthropic.com/legal/commercial-terms
- Anthropic — Usage Policy (eff. **2025-09-15**): scope ("including via any
  authorized resellers or passthrough access"), enforcement (throttle/suspend/
  terminate), the Supported-Regions/account-access rule:
  https://www.anthropic.com/legal/aup
- Anthropic — Service Specific Terms (eff. **2026-06-08**): https://www.anthropic.com/legal/service-specific-terms
- Anthropic — Plans & Pricing (retrieved 2026-08-14): Pro $17/mo annual/$20
  monthly, Max from $100/mo, Team $20/seat/mo annual, Enterprise $20/seat +
  usage at API rates; API rates Opus 5 $5/$25, Sonnet 5 $2/$10, Fable 5 $10/$50,
  Haiku 4.5 $1/$5; FAQ on pay-as-you-go API credits for heavy coding:
  https://claude.com/pricing
- OpenAI — Terms of Use (eff. **2026-01-01**): Registration ("may not share your
  account credentials or make your account available to anyone else"), "What you
  cannot do" (lease/sell/distribute; automatic or programmatic extraction), scope
  note pointing business/API use to the Services Agreement:
  https://openai.com/policies/terms-of-use/
- OpenAI — Services Agreement (formerly Business Terms; updated **2025-12-01**,
  eff. **2026-01-01**): scope; §2.2 integrate the API into Customer Applications
  for End Users; §3.1 no sharing credentials / no reselling or leasing access to
  the Account; §3.3(g) no buying/selling/transferring API keys; §3.3(h) no
  circumventing rate limits: https://openai.com/policies/business-terms/
- OpenAI — Usage Policies (eff. **2025-10-29**): https://openai.com/policies/usage-policies/
- OpenAI — Codex product page (retrieved 2026-08-14): "all connected by your
  ChatGPT account": https://openai.com/codex/
- OpenAI — Codex pricing docs (retrieved 2026-08-14): plan prices (Free $0, Go
  $8/mo, Plus $20/mo, Pro from $100/mo, Business $20/user/mo); "API Key: Great
  for automation in shared environments like CI"; "Pay only for the tokens Codex
  uses, based on API pricing": https://openai.com/codex/pricing
- OpenCode — repository (MIT license, retrieved 2026-08-14): https://github.com/anomalyco/opencode
- Repo grounding — `packages/config/src/models.json` (subscription-auth model
  notes models.json:15/27/39/51/64/77/90/103; opencode-sonnet models.json:239-244,
  providerModel at models.json:248; costPerMtok figures per model),
  `packages/core/src/usage/subscription.ts` (Claude OAuth credential path
  subscription.ts:27-34), `packages/core/src/harness/claude-cli.ts` (`claude -p`
  claude-cli.ts:81), `codex-cli.ts` (`codex exec --json` codex-cli.ts:33),
  `opencode.ts` (`opencode run` opencode.ts:23), `packages/core/src/harness/catalog.ts`
  (claude-cli selfAuth, catalog.ts:39), `packages/config/src/routes.json`
  (build_codex `requires: codex` routes.json:20, build_claude `requires: claude`
  routes.json:25), `packages/config/src/factory.json` (cost_tracking
  factory.json:40-44), ADR-0020 (cost KPIs), the sequencing docs
  `docs/research/sandbox-posture-audit.md` (#618), `sandbox-tech-comparison.md`
  (#619), `hosting-comparison.md` (#620), `hosted-credentials.md` (#621),
  `hosted-sandbox-recommendation.md` (#622), and ADR-0023 / ADR-0024 — all cited
  by file:line in the body of this document.
