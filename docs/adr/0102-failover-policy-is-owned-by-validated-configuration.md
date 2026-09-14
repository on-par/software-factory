# ADR-0102: Failover policy is owned by validated configuration

- Status: Accepted
- Date: 2026-09-14

## Context

Inherited service environment variables could override an explicitly configured
failover policy. An old `FACTORY_AUTO_FAILOVER=0` disabled an automatic run;
the opposite value could enable failover for a deliberately pinned run.
Cooldown and fallback-model overrides had the same hidden precedence.

## Decision

`resolveAutoFailover` accepts only validated `FactoryConfig`. The existing
`auto_failover.enabled`, `cooldown_minutes`, and `fallback_model` fields are
authoritative. Packaged defaults still supply omitted fields through the loader.
The resolver no longer accepts or reads an environment argument.

`FACTORY_AUTO_FAILOVER`, `FACTORY_FAILOVER_COOLDOWN_MINUTES`, and
`FACTORY_FAILOVER_MODEL` no longer affect execution. This amends the failover
exception documented in ADR-0092 and preserves ADR-0055's resolved-policy boundary.

Execution-policy settings should migrate to validated configuration at the
adapter boundary and be passed to the engine as resolved values. New policy
settings must not introduce environment overrides. Credentials and process setup
such as PATH remain environment concerns.

## Migration

Before upgrading, move any intentional values into `.factory/config.json`:

```json
{
  "auto_failover": {
    "enabled": true,
    "cooldown_minutes": 30,
    "fallback_model": "claude-sonnet-5"
  }
}
```

Remove the three retired variables from service definitions and scripts. Stale
copies are harmless to the upgraded resolver. Operators who intentionally disabled
failover using only the environment must persist `enabled: false` before upgrade.

## Scope and verification

This change migrates failover policy only. Experimental-model eligibility, model
pins/provider switches, merge policy, headless execution, and other existing
environment-based decisions need separate migrations with explicit ownership and
compatibility tests. Their current behavior is unchanged.

Regression tests inject contradictory process variables for both enabled and
disabled configurations, and verify that the saved policy wins for all three
fields. The resolver has no process-environment dependency to reintroduce silently.
