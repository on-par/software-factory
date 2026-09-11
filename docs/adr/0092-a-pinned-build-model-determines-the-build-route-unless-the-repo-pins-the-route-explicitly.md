# ADR-0092: A pinned build model determines the build route unless the repo pins the route explicitly

- Status: Accepted
- Date: 2026-09-10

## Context

The build route (`codex` | `claude` | `opencode`) is chosen by the PLAN
model and frozen into the spec (ADR-0001's boss-worker split). The route
selects a router task (`build_codex` / `build_claude` / `build_opencode`)
whose tier lists only workers of that harness. A repo may pin a build
model (`models.build` in `.factory/config.json`, or `FACTORY_BUILD_MODEL`)
and, separately, pin the route (`route`). `run-issue.ts` then dropped any
build pin whose harness did not match the chosen route, logging
`model_override_ignored`.

That made the two pins interact in a way operators do not expect: pinning
`models.build: claude-sonnet-5` with `providers.openai: false` still let
PLAN pick `codex`, the pin was discarded, and BUILD ran on a GPT worker
(on-par/sound-buddy #1392, 2026-09-10; software-factory #1367). The plan
prompt only taught the boss to honor opencode-harness pins.

## Decision

1. **A pinned build model implies its route.** `routeForBuildModel`
   (`config/repo.ts`) maps a model's harness to the one route that can run
   it: Codex-harness → `codex`, opencode → `opencode`, claude-cli →
   `claude`; models without a dedicated route (e.g. ollama-http) imply
   nothing.
2. **Precedence: explicit `route` > build pin > PLAN.**
   `resolveEffectiveBuildRoute` encodes it; `run-issue.ts` computes the
   pinned route once per issue, logs `model-override: build route derived
from pinned build model X → Y` when it came from the pin, feeds it to
   PLAN through the existing `preferredRoute` path (so the spec is
   rewritten with the existing `repo-config-pin` reason), and re-applies it
   before BUILD so a plan port that ignores `preferredRoute` (a daemon, a
   test double) still cannot route a pinned worker elsewhere.
3. **A pin cannot resurrect a route the operator turned off.** No route
   is derived in local-only mode (PLAN forces codex there), and a
   Codex-harness pin derives nothing while codex is disabled
   (`providers.openai: false`, `FACTORY_CODEX=0`, or an open breaker) —
   PLAN's codex→claude fallback then applies and the pin is dropped as
   incompatible, as before. `buildPhase` backs this up: when it flips a
   codex route to claude it also drops a Codex-harness `modelOverride`,
   because an override skips the tier's provider filter and would run the
   codex model on the claude route anyway.
4. **`model_override_ignored` stays, but only for a real conflict.** The
   only way to reach it now is an explicit `route` that contradicts the
   pin; the message says the route was pinned by `.factory/config.json`.
5. **The plan prompt states the rule** for claude-cli pins as it already
   did for opencode, and says the factory enforces it, so the boss and the
   guard agree in the common case.
6. **`factory status --kpis` shows the effective route** and its source:
   `Build route: claude (derived from build pin claude-sonnet-5)`,
   `(.factory/config.json)`, or `plan decides (default)`.

## Consequences

- Pinning an Anthropic worker is now sufficient to keep BUILD on
  Anthropic; `route` is only needed to force a route _against_ the pin or
  when no build model is pinned.
- The derivation lives in `config/`, which must not import `run/`, so
  `BuildRoutePin` duplicates the `BuildRoute` literal union.
- Breaker-driven failover (`preferFallbackWhenProviderIsOpen`) still
  applies on top of the pinned route; `FACTORY_AUTO_FAILOVER=0` disables it,
  unchanged.
- `providers.openai: false` continues to flip a codex route to claude inside
  `buildPhase`; with this ADR that path is no longer how an Anthropic pin
  gets honored, only a backstop.
