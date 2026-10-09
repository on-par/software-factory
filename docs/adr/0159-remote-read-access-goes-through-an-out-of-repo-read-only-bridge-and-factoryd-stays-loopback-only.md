# ADR-0159: Remote read access goes through an out-of-repo read-only bridge, and factoryd stays loopback-only

- Status: Proposed
- Date: 2026-10-09
- Amends: [ADR-0034](0034-factoryd-s-http-api-is-authorized-by-its-loopback-binding-alone.md) (remote reads go through a separate read-only bridge; factoryd's loopback-only authorization model is unchanged)

## Context

[ADR-0034](0034-factoryd-s-http-api-is-authorized-by-its-loopback-binding-alone.md) authorizes factoryd's HTTP API by
its `127.0.0.1` binding alone. The routes do no authentication check. It also says that any remote-access story
supersedes it, unless real authentication lands in the same change.

Several later ADRs build on that rule. They are local-only app and API decisions:

- [ADR-0094](0094-the-app-explains-an-attach-rejection-from-factoryd-s-reason-code-never-from-its-detail-string.md):
  the app explains an attach rejection from the reason code.
- [ADR-0095](0095-repo-detail-is-addressed-by-the-repo-query-parameter-and-filtered-on-both-the-server-and-the-client.md):
  repo detail is addressed by the `repo` query parameter.
- [ADR-0096](0096-the-app-settings-api-writes-only-allow-listed-safe-policy-fields.md): the settings API writes only
  allow-listed safe policy fields.
- [ADR-0097](0097-an-app-launched-factoryd-run-is-fenced-by-an-exclusive-create-of-its-run-record-file.md): an
  app-launched run is fenced by an exclusive create of its run record.
- [ADR-0098](0098-enabling-admin-merge-requires-a-distinct-confirmation-token-shared-with-the-audit-text.md): enabling
  admin merge needs a distinct confirmation token.
- [ADR-0099](0099-an-absent-usage-reading-renders-as-explicitly-unavailable-never-as-zero-and-never-as-an-armed-watchdog.md):
  an absent usage reading renders as unavailable, never as zero.
- [ADR-0100](0100-the-attached-repo-roster-is-a-one-shot-read-of-the-persisted-registry-lane-state-stays-a-pure-sse-projection.md):
  the repo roster is a one-shot registry read.
- [ADR-0101](0101-the-app-s-repo-list-is-a-registry-read-never-a-projection-of-the-lane-stream.md): the repo list is a
  registry read, not a lane-stream projection.

A planned read-only native iOS client (epic [#2266](https://github.com/on-par/software-factory/issues/2266)) needs
daemon, queue, runs, cost, usage and log data from outside the Mini. We must not widen factoryd to serve it.

## Decision

factoryd's HTTP API on `:8787` stays loopback-only. It is never tunneled or proxied.

Remote reads go only through a separate read-only bridge. The bridge lives outside this repo, in on-par/ship-it
(`Packages/FactoryBridge`). It binds `127.0.0.1:8788`, serves a GET-only allowlist, and runs fixed commands. Each one
runs with `--json`:

- `factory daemon status`
- `factory status`
- `factory queue list`
- `factory cost`
- `factory usage`
- `factory runs`
- `factory runs --diffstat`
- `factory logs`

The bridge is reachable only through Cloudflare Tunnel `ship-it-zglihd.onpardev.com`, behind Cloudflare Access with a
service-token policy. cloudflared enforces Access at the origin. The bridge also validates the Access JWT itself and
fails closed.

The bridge never proxies factoryd routes. That includes the routes covered by ADR-0094 to ADR-0101, which stay
local-only and unchanged.

The CLI `--json` outputs ([#2267](https://github.com/on-par/software-factory/issues/2267),
[#2268](https://github.com/on-par/software-factory/issues/2268),
[#1101](https://github.com/on-par/software-factory/issues/1101),
[#2269](https://github.com/on-par/software-factory/issues/2269),
[#2270](https://github.com/on-par/software-factory/issues/2270),
[#2271](https://github.com/on-par/software-factory/issues/2271),
[#2272](https://github.com/on-par/software-factory/issues/2272)) are the only contract for the macOS app and the
bridge.

This amends ADR-0034. It does not supersede it. ADR-0034 says a remote-access story supersedes it unless it lands real
authentication. Here factoryd's binding and its no-auth-check rule stay exactly as they are. The remote surface is a
different process with real authentication: Cloudflare Access plus JWT validation at the bridge, which fails closed.
So ADR-0034's condition is met outside factoryd.

## Consequences

- factoryd and its authorization model do not change.
- Write actions stay local-only.
- A second process must be deployed and kept in sync with the CLI. ship-it contract CI covers drift.
- Any write route over a remote surface needs a new ADR with a real authentication design.

## References

- [ADR-0034](0034-factoryd-s-http-api-is-authorized-by-its-loopback-binding-alone.md)
- [ADR-0094](0094-the-app-explains-an-attach-rejection-from-factoryd-s-reason-code-never-from-its-detail-string.md),
  [ADR-0095](0095-repo-detail-is-addressed-by-the-repo-query-parameter-and-filtered-on-both-the-server-and-the-client.md),
  [ADR-0096](0096-the-app-settings-api-writes-only-allow-listed-safe-policy-fields.md),
  [ADR-0097](0097-an-app-launched-factoryd-run-is-fenced-by-an-exclusive-create-of-its-run-record-file.md),
  [ADR-0098](0098-enabling-admin-merge-requires-a-distinct-confirmation-token-shared-with-the-audit-text.md),
  [ADR-0099](0099-an-absent-usage-reading-renders-as-explicitly-unavailable-never-as-zero-and-never-as-an-armed-watchdog.md),
  [ADR-0100](0100-the-attached-repo-roster-is-a-one-shot-read-of-the-persisted-registry-lane-state-stays-a-pure-sse-projection.md),
  [ADR-0101](0101-the-app-s-repo-list-is-a-registry-read-never-a-projection-of-the-lane-stream.md)
- software-factory issues: [#2266](https://github.com/on-par/software-factory/issues/2266),
  [#2267](https://github.com/on-par/software-factory/issues/2267),
  [#2268](https://github.com/on-par/software-factory/issues/2268),
  [#2269](https://github.com/on-par/software-factory/issues/2269),
  [#2270](https://github.com/on-par/software-factory/issues/2270),
  [#2271](https://github.com/on-par/software-factory/issues/2271),
  [#2272](https://github.com/on-par/software-factory/issues/2272),
  [#2273](https://github.com/on-par/software-factory/issues/2273),
  [#1101](https://github.com/on-par/software-factory/issues/1101)
- ship-it issues: [#1](https://github.com/on-par/ship-it/issues/1),
  [#13](https://github.com/on-par/ship-it/issues/13), [#14](https://github.com/on-par/ship-it/issues/14),
  [#15](https://github.com/on-par/ship-it/issues/15), [#16](https://github.com/on-par/ship-it/issues/16),
  [#17](https://github.com/on-par/ship-it/issues/17)
