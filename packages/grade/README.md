# @on-par/factory-grade

Read-only grader for recorded factory runs. It reads run records through the
`@on-par/factory-core` run store (`readIssueRunState`) from `getFactoryPaths(repoRoot).runs`.
It has no store of its own and never writes, creates or deletes anything.

```ts
import { loadRuns } from '@on-par/factory-grade';

const { runs, skipped } = await loadRuns(runsDir, { since: new Date('2026-10-05') });
```

`loadRuns` returns runs sorted by `startedAt` then `issue`. A missing directory gives an empty result,
unreadable `issue-<n>.json` files are named in `skipped`, and other files are ignored. With `since`,
runs started on or after that instant are kept (runs with an unparsable `startedAt` are dropped);
an invalid `since` throws `RangeError`.

## Report schema v1

`validateGradeReport(value)` returns `{ ok: true, report }` or `{ ok: false, errors }` with
path-qualified messages. All objects are strict: unknown keys are rejected.

| Field                               | Type                                             | Meaning                                             |
| ----------------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| `schemaVersion`                     | `1`                                              | Schema version literal.                             |
| `generatedAt`                       | ISO datetime string                              | When the report was produced.                       |
| `since`                             | ISO datetime string or `null`                    | The `since` filter applied, `null` when none.       |
| `runCount`                          | integer >= 0                                     | Number of runs graded.                              |
| `scores.overall`                    | number 0..1                                      | Overall score across runs.                          |
| `scores.runs[]`                     | array                                            | One entry per graded run.                           |
| `scores.runs[].issue`               | positive integer                                 | Issue number.                                       |
| `scores.runs[].repo`                | string, optional                                 | `owner/name` slug.                                  |
| `scores.runs[].model`               | string                                           | Model that built the run.                           |
| `scores.runs[].status`              | non-empty string                                 | Run status.                                         |
| `scores.runs[].score`               | number 0..1                                      | 0 worst, 1 no failure modes found.                  |
| `failureModes[]`                    | array                                            | One entry per failure-mode kind observed.           |
| `failureModes[].kind`               | enum                                             | One of the kinds below.                             |
| `failureModes[].count`              | integer >= 0                                     | Times observed across all graded runs.              |
| `failureModes[].issues`             | positive integers                                | Issues exhibiting the mode, ascending.              |
| `failureModes[].evidence[]`         | array                                            | Supporting evidence.                                |
| `failureModes[].evidence[].issue`   | positive integer                                 | Issue the evidence belongs to.                      |
| `failureModes[].evidence[].phase`   | `plan` \| `build` \| `check` \| `ship`, optional | Phase of the evidence.                              |
| `failureModes[].evidence[].source`  | non-empty string                                 | Where it came from, e.g. `state/events.ndjson`.     |
| `failureModes[].evidence[].excerpt` | string                                           | Short verbatim excerpt (command line, park reason). |

Failure-mode kinds: `redundant-test`, `relearn-test-command`, `repeated-failing-command`,
`park-reason-cluster`, `model-phase-failure`.

Versioning: additive optional fields keep `schemaVersion: 1`; removing or renaming a field, or
changing a type, bumps it.
