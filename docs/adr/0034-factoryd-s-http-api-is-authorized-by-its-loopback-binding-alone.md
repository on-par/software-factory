# ADR-0034: factoryd's HTTP API is authorized by its loopback binding alone

- Status: Accepted
- Date: 2026-08-19

## Context

Epic #761 puts a control-plane HTTP API on `factoryd`: this story adds GET /repos,
and sibling stories add POST /repos (attach a checkout), pause/resume, and DELETE
(drain-or-force detach). Those routes act on a user's local checkouts and on running
lanes, so the API is privileged even though it never handles secrets directly. The
epic explicitly defers authentication and authorization ("localhost only for now"),
and this story's out-of-scope list repeats it. That leaves an implicit question every
later route will re-ask: what stops an unauthorized caller? Answering it per-route
invites drift — one route binding 0.0.0.0 "for testing", another adding a bearer
token nobody else checks. The single-user, single-machine deployment target (the
factory runs on the operator's own laptop against their own checkouts) makes the OS's
loopback boundary a real, sufficient control today, but only if it is never widened.

## Decision

factoryd binds 127.0.0.1 and treats that binding as its entire authorization model.
`createFactorydServer` defaults `host` to '127.0.0.1'; the option exists so tests can
be explicit, not so production can widen it, and no CLI flag exposes it. No route
performs an authorization check, and no route may assume one has happened. Every
route added under this epic — including the mutating attach/detach/pause/resume
routes — inherits this contract unchanged, and a test asserting
`server.address().address === '127.0.0.1'` is part of the module's suite.
Introducing any non-loopback binding, or any remote-access story, supersedes this ADR
and must land real authentication in the same change, not after it.

## Consequences

Positive: the API stays trivial to call (curl, no token plumbing, no key storage) and
there is no half-built auth layer to maintain or to mistake for a security boundary.
The rule is one line to state and one assertion to enforce, so review can check it.
Negative: factoryd cannot be driven from another machine, from a container without
host networking, or from a browser on a different origin — any of those needs this
decision revisited first. Every process on the operator's machine can read the
registry and (once the mutating routes land) attach, pause, and detach repos, so the
trust boundary is the machine, not the user account's own processes. That is
acceptable for the single-operator laptop deployment and would not be for a shared or
multi-tenant host.

## References

- [Epic #761 — factoryd: repo registry + attach/detach/pause HTTP API](https://github.com/on-par/software-factory/issues/761)
- [Issue #777 — factoryd: localhost HTTP server with GET /repos](https://github.com/on-par/software-factory/issues/777)
- [ADR-0004 — A narrow public API for @on-par/factory-core](https://github.com/on-par/software-factory/blob/main/docs/adr/0004-narrow-public-core-api.md)
