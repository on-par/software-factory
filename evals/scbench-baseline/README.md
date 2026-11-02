# SlopCodeBench baseline archive

This directory holds the [pinned config](./baseline.config.json), 12 committed
live `cfgpipe` trials with native evidence in [runs/](./runs), and the
generated [report.md](./report.md).

The adapter and launcher that produced and compared these runs were removed.
The data is a frozen record, and `report.md` can no longer be regenerated.

See [ADR-0007](../../docs/adr/0007-slopcodebench-baseline-correctness-derives-only-from-retained-native-scbench-evidence.md),
[ADR-0008](../../docs/adr/0008-slopcodebench-problem-inputs-come-from-a-pinned-scb-problems-revision-injected-via-scbench-problems-path.md),
and [ADR-0083](../../docs/adr/0083-the-committed-scbench-baseline-runs-tree-holds-only-live-trials-report-status-expresses-comparison-readiness-not-measurability.md),
which are now deprecated.
