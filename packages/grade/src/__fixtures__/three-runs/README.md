# three-runs fixture

Mirrors a factory state root: `state/runs/issue-<n>.json` (committed `IssueRunState` records),
`state/runs/issue-102.phase.json` (a phase snapshot sibling the loader must ignore) and
`state/events.ndjson` (one `FactoryEvent` per line).

| Issue | startedAt                | Status | Planted pattern                                                                                                                                |
| ----- | ------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 101   | 2026-10-01T09:00:00.000Z | parked | **redundant-test**: the identical `npm run test` run 4 times in BUILD with no file change between runs                                         |
| 102   | 2026-10-05T00:00:00.000Z | ready  | **relearn-test-command**: 4 distinct attempts to find the test command in one CHECK: `npm test`, `npx vitest run`, `pnpm test`, `npm run test` |
| 103   | 2026-10-08T14:30:00.000Z | merged | none (control): one test command after an edit                                                                                                 |
