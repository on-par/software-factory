# ADR-0096: The app settings API writes only allow-listed safe policy fields

- Status: Accepted
- Date: 2026-09-12

## Context

The factoryd control plane binds 127.0.0.1 and treats that binding as its
entire authorization model — there is no auth and no per-request identity.
Giving the settings screen a way to persist edits means giving a browser
page a way to write `.factory/config.json` in an attached checkout, and
that file is not a bag of harmless preferences: it also carries model
pins, provider enable flags, tier order, usage caps, and the sandbox
section. A generic "PATCH the config" endpoint would therefore let any
page that can reach loopback pin a build model, disable the sandbox, or
raise the usage cap. Issue #1389 also scopes the UI to fields "designated
safe for routine editing", and explicitly leaves fields whose value is
currently decided by a CLI flag or an env var read-only for this slice, so
the set of writable fields has to be an explicit, inspectable thing rather
than whatever the client happens to send.

## Decision

`packages/core/src/config/policy.ts` owns `SAFE_POLICY_FIELDS`, the single
declarative allow-list of repo policy fields the app may edit, and it is
the only list the settings API consults. `setSafeRepoPolicyField` accepts
a `SafePolicyFieldId` and a boolean and writes exactly that one key path
into the raw config JSON, leaving every other key byte-for-byte intact;
`PUT /repos/<owner>/<name>/policy` rejects any other field id or a
non-boolean value with 400 and writes nothing. Adding a field to the
settings screen means adding an entry to `SAFE_POLICY_FIELDS` — with its
label, its config key path, its env var, and its flag name — and nothing
else. Fields whose effective value currently comes from a flag or an env
var are reported with `editable: false`, and the UI disables their
control; the allow-list governs what may be written, the source governs
what is worth writing. The first entry is `merge.auto`; `merge.admin` is
deliberately excluded and handled as a distinct, audited choice by #1390.

## Consequences

Positive: the write surface exposed to the browser is enumerable in one
place and reviewable in one diff; the loopback-only posture stays
defensible because reaching the port no longer implies arbitrary config
authorship; each field carries its env var and flag name next to its
config key, so source attribution and the allow-list cannot drift apart.
Negative: every new settings control costs an allow-list entry plus a
test, so the screen cannot grow by generic reflection over the config
schema; the allow-list duplicates key paths that also exist in
`FactoryConfigSchema`, and a rename there must be mirrored here (the
resolver's tests pin the effective value against the packaged defaults,
so a drifted key path fails loudly rather than silently reporting a
default).

References:

- Issue #1389 — App settings: edit safe repo policy fields with
  source-aware feedback
- Epic #1378 — Runtime policy flags replace machine env toggles
- Issue #1390 — App settings: admin-merge requires distinct confirmation
  and audit text
