# ADR-0163: DeepSeek models are reached only through approved zero-retention intermediaries

- Status: Accepted
- Date: 2026-10-14
- Issue: #2894

## Context

The packaged model `deepseek-v3` talked to DeepSeek's first-party API (provider `deepseek`, `DEEPSEEK_API_KEY`)
through `claude -p --model deepseek/deepseek-chat`. The Claude CLI cannot serve that model, so the wiring never
worked. If it had, it would have sent repository code to a service hosted in the PRC.

- The DeepSeek privacy policy (2026-02-10) says user data is stored in the PRC and may be used for training.
- The DeepSeek Open Platform Terms of Service (2026-04-29) give no zero-retention commitment.

The model still sat in the default `worker` tier.

## Decision

- DeepSeek models are reached only through approved zero-retention intermediaries:
  - OpenRouter, with a zero-data-retention (ZDR) key.
  - OpenCode Go, while its DeepSeek zero-retention deal holds.
- Azure Microsoft Foundry is pending verification and is NOT approved.
- The native `deepseek/` provider and `DEEPSEEK_API_KEY` are refused in OpenCode and Pi alike.
- `deepseek-v3` is removed from the packaged models and from `tiers.worker`. A stale repo pin, tier or
  `FACTORY_PLAN_MODEL` / `FACTORY_BUILD_MODEL` override fails as an unknown model and the error points at
  `opencode-deepseek-v4-flash`, via the `retiredModels` map in `packages/config/src/defaults.ts`.
- Review trigger: 2026-10-31, when the OpenCode Go ZDR deal expires.

## Consequences

- No automatic tier can route to DeepSeek's first-party API. A guard test in `defaults.test.ts` fails if a packaged
  model has provider `deepseek` or envKey `DEEPSEEK_API_KEY`.
- Refusing direct DeepSeek endpoints in repo config comes later (pi-02). The `deepseek` provider enum value stays
  until then.

## References

- #2894, #2863, #2410
