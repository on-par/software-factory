# Upstream factory reports

When the factory itself fails (not the target repo), it can file a redacted `[factory-report]` issue on the
factory repo (`on-par/software-factory`). See ADR-0132 for the design.

## What is sent

Only the output of `buildUpstreamReport`:

- factory version and commit
- phase, failure reason and component
- fingerprint
- redacted error class and message
- factory-package stack frames (package-relative)
- harness and model
- OS and Node version

Never sent: the target repo slug, paths, branches, issue text, diffs or log excerpts.

Issues get the `[factory-report]` title prefix and a trailing `<!-- factory-upstream-report v1 fp:… -->`
marker. They are created with no labels.

## How it is sent

The run's existing GitHub auth (`GH_TOKEN` or `gh auth token`) creates the issue. If that auth is missing or
cannot create issues on the factory repo (401/403/404/410 or any other failure), the report is written to
`~/.factory/filing/outbox/<fingerprint>.json` and `upstream_report_outboxed` is logged with the reason.
Nothing is lost and the run does not fail.

`filing.maxPerRun` and `filing.maxPerDay` cap new issues per operator. Created issues are counted in
`~/.factory/filing/upstream-ledger.json`, so the daily cap holds across runs. Reports over a cap are dropped
and logged as `upstream_report_skipped`; they are not outboxed.

## Preview

`factory filing preview <run-id>` prints the exact title and body and sends nothing.

## Turning it off

Set `filing.enabled: false` in `.factory/config.yaml` to disable all sending. Upstream sending is off by
default and only happens in the auto mode added by #1859.
