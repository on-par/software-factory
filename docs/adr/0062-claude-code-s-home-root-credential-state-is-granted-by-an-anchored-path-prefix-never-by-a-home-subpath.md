# ADR-0062: Claude Code's home-root credential state is granted by an anchored path prefix, never by a home subpath

- Status: Accepted
- Date: 2026-08-29

## Context

On darwin the factory contains agentic runs with `sandbox-exec` under
`(allow default) (deny file-write*)` plus an explicit subpath write allowlist
(`packages/core/src/sandbox/index.ts`, `resolveSandboxPolicy` /
`buildDarwinProfile`). That allowlist granted `~/.claude`, but Claude Code keeps its
session/credential state in the home-root file `~/.claude.json` and rewrites it
atomically: it writes `~/.claude.json.tmp.<pid>.<hash>`, then renames over
`~/.claude.json`, keeping `~/.claude.json.backup`. It also refreshes the macOS
keychain item `Claude Code-credentials` under `~/Library/Keychains`. Neither target
was writable, so `claude -p` succeeded on the host and failed with `local_auth`
inside the sandbox (#1008): PLAN and BUILD failed over to a weak local model,
produced invalid design artifacts and no-diff builds, and parked a whole morning of
ops issues (#652, #653, #654, #1004, #1005, #1007) as product failures.
SBPL `(subpath "…/.claude.json")` matches only that path and children beneath it —
it does not match the sibling `.tmp.*` and `.backup` files that the atomic write
actually creates — so the obvious one-line fix does not work. Granting the home
directory would work and is unacceptable: it voids the containment the sandbox
exists to provide.

## Decision

`SandboxPolicy` carries a `writableFilePrefixes: string[]` field, distinct from the
subpath-shaped `writablePaths`. `resolveSandboxPolicy` populates it with exactly
`<home>/.claude.json`, and adds `<home>/Library/Keychains` to `writablePaths` on
darwin only. `buildDarwinProfile` renders each prefix as a single anchored SBPL rule,
`(allow file-write* (regex #"^<escaped-prefix>"))`, where the path is first
regex-escaped and then SBPL-string-escaped; `wrapCommandInSandbox` renders the same
prefixes as firejail `--read-write=` flags. No rule ever grants the home directory
itself, and the existing `(deny file-write*)` default and `(deny network-outbound)`
egress rule are unchanged. Any future credential or state file the sandbox must let
an agent write is added as a narrow entry to `writablePaths` or
`writableFilePrefixes` — widening to a parent directory to cover a temp-file sibling
is not an available option.

## Consequences

Positive: sandboxed Claude runs can refresh their own session with the same
credentials that work on the host, so darwin runs stop parking on `local_auth`; the
grant is auditable, one anchored rule per prefix, and the blast radius of the widened
allowlist is `~/.claude.json*` plus the keychain directory rather than all of $HOME.
The prefix concept generalizes to the next tool that writes home-root state
atomically. Negative: the SBPL regex is escaped by hand, and a malformed rule makes
`sandbox-exec` reject the entire profile and break every agentic run on darwin, so
the rendered rule must stay pinned by unit tests. A prefix grant is genuinely broader
than a literal — anything whose absolute path starts with `~/.claude.json` is
writable. Granting `~/Library/Keychains` lets a compromised agent write the user's
login keychain; that is the minimum access Claude Code's credential refresh needs on
darwin, and `FACTORY_SANDBOX=0` remains the documented escape hatch in the other
direction. `SandboxPolicy` gains a required field, so every construction site must
supply it.

## References

- [Issue #1008 — sandbox-exec: Claude local_auth](https://github.com/on-par/software-factory/issues/1008)
- [App Sandbox Design Guide — SBPL filesystem filters](https://developer.apple.com/library/archive/documentation/Security/Conceptual/AppSandboxDesignGuide/AboutAppSandbox/AboutAppSandbox.html)
