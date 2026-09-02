# ADR-0076: factory daemon wraps launchd in the gui domain, and start is a full reinstall

- Status: Accepted
- Date: 2026-09-02

## Context

factoryd must survive crashes and reboots on macOS, and its Claude Max
workers need login-keychain access for OAuth refresh — which only the
`gui/<uid>` launchd domain (or a login shell) provides
(docs/runbooks/macos-keychain-launchagent.md, #1014). launchd's
`bootstrap` fails when a label is already loaded, so a naive install is
not idempotent, and operators migrating incrementally still have other
repos on the legacy cron relaunch script, so nothing may assume the
daemon owns every repo on the machine.

## Decision

`factory daemon start` always performs a full reinstall: it regenerates
`~/Library/LaunchAgents/com.onpar.factoryd.plist` (KeepAlive=true,
RunAtLoad=true, stdout/stderr appended to `~/.factory/daemon.log`, and
ProgramArguments resolved at install time to the absolute node binary
and CLI script running the command), then `launchctl bootout` in the
gui domain ignoring failure, then `launchctl bootstrap gui/<uid>`.
`stop` is `launchctl bootout` only — the plist stays on disk, and a
not-loaded agent is success. All launchctl and ps invocations go
through an injected exec seam so the wrappers are unit-testable off
macOS. A repo is managed by exactly one supervisor: it is either
attached to factoryd or driven by a cron relaunch line, never both.

## Consequences

Positive: start is idempotent and self-healing (a stale or hand-edited
plist is simply replaced), kill-the-pid recovery is delegated entirely
to launchd's KeepAlive, and the gui domain keeps keychain-backed Claude
auth working. Rollback is symmetric: `factory daemon stop` plus
re-adding the cron line. Negative: start restarts a healthy daemon
(brief control-plane outage, engines relaunched by their supervisors);
the install-time-resolved node/CLI paths go stale if the CLI is moved
or upgraded in place, requiring a re-run of `factory daemon start`; and
the attach-XOR-cron rule is enforced by runbook, not code — attaching a
cron-managed repo yields two engines until the operator removes the
cron line.

## References

- [Issue #1179](https://github.com/on-par/software-factory/issues/1179)
- [Epic #764](https://github.com/on-par/software-factory/issues/764)
- [macOS keychain LaunchAgent runbook](https://github.com/on-par/software-factory/blob/main/docs/runbooks/macos-keychain-launchagent.md)
