# ADR-0057: Factory prompts are self-contained — they reference only their own text and named repo files

- Status: Accepted
- Date: 2026-08-27

## Context

#959 removed the `/ship-it <issue>` slash token from the BUILD prompt but left the
prose clause "so SKIP ship-it's worktree-creation step" behind it. That clause
instructs the model to skip a step of a Claude Code skill (`~/.claude/skills/ship-it`)
that the harness never loads — `claude -p` runs a bare prompt file. `~/.claude/skills`
is unversioned, user-level, and machine-specific: a job container has no such folder,
so any prompt that leans on it is laptop-only behaviour that fails in CI/production.
Skills are also a Claude Code mechanism with no equivalent in the codex, opencode, or pi
harnesses, so a skill dependency breaks the provider-neutrality of the harness contract.
Nothing structurally prevented the next prompt builder from adding another such
dangling reference.

## Decision

A factory prompt may reference only its own text and repo files it names by path —
never anything under `~/` and never a Claude Code skill or slash-command token. Where a
consumer repo needs to customise factory behaviour, constitutions are the existing,
versioned, per-repo extension point (#721 moved constitutions into consumer repos); a
second out-of-band mechanism is not introduced. A colocated regression guard
(`packages/core/src/phases/prompt-self-contained.test.ts`) renders every prompt builder
in `packages/core/src/phases/` and fails, naming the offending builder, if a rendered
prompt begins with a slash-command token or references a known user-level skill.

## Consequences

Positive: build/plan prompts behave identically on a laptop, in CI, and in a
skills-less job container; the harness contract stays provider-neutral; regressions
are caught at test time with the builder named. Negative: prompt builders must be
exported to be directly guardable (a slightly wider module surface), and the guard's
skill denylist must be kept in step with real Claude Code skill names — a bare skill
name reused as a git branch prefix (e.g. `ship-it/962`) is deliberately not a
violation, so the guard matches reference forms (`/name`, `name's`, `name skill`), not
the bare substring.

## References

- [Issue](https://github.com/on-par/software-factory/issues/962)
- [#959 — removed the /ship-it slash token](https://github.com/on-par/software-factory/issues/959)
- [#721 — constitutions moved into consumer repos](https://github.com/on-par/software-factory/issues/721)
