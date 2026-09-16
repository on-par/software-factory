# CLI queue compatibility with Factory App admission state

Reference: #1497 (Factory App epic on-par/factory-app#518). Documents the compatibility
contract between the CLI's GitHub-label work queue and Factory App's Work Source +
admission model, and the `factory queue reconcile` diagnostic that surfaces conflicts
between the two.

## Two authorities

GitHub labels (`factory:queued`, `factory:lane:*`, `factory:in-progress`, …) mean
**intake eligibility only** — an issue carrying them is _eligible_ to be claimed by the
CLI's label-driven queue (`GithubQueue.claimNext`, #824). They no longer mean the issue
is actually safe to claim.

Factory App admission state, when present, is the **execution authority**. If Factory
App has admitted an issue into a Turso-backed delivery, is actively executing it, or has
decomposed it into child issues, the CLI must not claim it — regardless of what GitHub
labels say. The CLI reads Factory App's admission state before every claim and defers to
it on conflict.

## The record

`AdmissionState` is one of:

| State        | Meaning                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------ |
| `admitted`   | Factory App has admitted the issue into a delivery but not started it.                     |
| `executing`  | Factory App is actively executing the issue.                                               |
| `decomposed` | Factory App decomposed the issue into child issues; it is not an independent unit of work. |
| `released`   | Factory App has handed the issue back — CLI authority is restored.                         |

An `AdmissionRecord` carries `issue`, `state`, and optionally `deliveryId` (which
delivery owns it), `parent` (the parent issue, when this issue is a decomposition
child), `updatedAt` (ISO timestamp of Factory App's last write), and `repairUrl` (a
per-record repair pointer that overrides the default hint).

## Transport v1

Factory App writes `<repoRoot>/.factory/state/admission.json`:

```json
{
  "version": 1,
  "records": [
    { "issue": 1234, "state": "executing", "deliveryId": "del-789" },
    { "issue": 1235, "state": "decomposed", "parent": 1234 }
  ]
}
```

The CLI only reads this file, through the `AdmissionStateReader` port
(`packages/core/src/admission/index.ts`); it never writes it. The file is re-read on
every lookup — claims are minutes apart and Factory App may write in between. This
transport is a proposal from the CLI side and is pending confirmation against
on-par/factory-app#518; because it sits behind the `AdmissionStateReader` port,
swapping it for an HTTP or Turso-backed reader replaces one factory function and
touches no classifier, guard, or CLI logic.

## The three rules

1. **Absent means local.** No `admission.json`, or no record for the issue, resolves to
   `claimable`. This is what preserves pure CLI/local mode — the overwhelming majority
   of installations have no Factory App at all, and their behaviour does not change.
2. **A conflict defers; it never writes.** `admitted`, `executing`, and `decomposed`
   resolve to `refuse`, and the claim-time guard skips the issue (`{ kind: 'defer' }`)
   rather than parking it. Parking would strip `factory:queued` and add
   `factory:parked` — a write to shared GitHub state an in-flight Factory App delivery
   may own. The CLI declines to act; it does not arbitrate. `released` resolves to
   `claimable`.
3. **An unreadable source fails closed.** A present-but-unparseable file, an unsupported
   `version`, or a record naming an unknown state refuses every affected issue rather
   than risking a claim on stale or corrupt evidence.

Every refusal carries a repair pointer: the record's `repairUrl` when Factory App
supplies one, otherwise the default `FACTORY_APP_REPAIR_HINT`.

## Operator flow

`factory queue reconcile [--lane <lane>]` reads the current GitHub queue snapshot,
classifies each queued issue against admission state, and prints one line per
conflicting issue with its repair pointer:

```
queue reconcile — 3 queued issue(s), 1 conflict(s)
  [queue-migration] #1497: #1497 is executing in Factory App delivery del-789
    repair: Factory App → Deliveries → Repair: release or re-run the delivery there before claiming this issue from the CLI
```

Exit code is `0` when there are no conflicts, `1` when at least one exists — suitable for
scripting into a daemon health check or a pre-run gate.

## What is NOT covered

One-shot commands (`factory run-issue`, `factory ship`, `factory land`) bypass the queue
entirely and are not claims, so they are not guarded by this compatibility layer in this
slice. Whether an explicit human-invoked one-shot should also refuse against an
executing Factory App delivery is a follow-up question, not resolved here.
