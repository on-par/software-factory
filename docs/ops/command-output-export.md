# Command output export (OTLP)

CHECK captures the output of the commands it runs live, redacts it line by line and tags each line with run, issue,
lane, phase, command id and sequence number (#3994). This page covers the opt-in exporter that sends those records to
an OTLP/HTTP endpoint you operate. With export off, which is the default, nothing changes and no network is touched.

## What is exported

The redacted stdout and stderr lines of the CHECK phase's checkers, verify command and app smoke. The redaction from
#3994 runs first. Any value in `OTEL_EXPORTER_OTLP_HEADERS` or `OTEL_EXPORTER_OTLP_LOGS_HEADERS` (at least 4
characters, and the credential after a scheme such as `Bearer`) is also masked as `<secret>` in the text. Output outside CHECK, and model or agent output, is not exported.

## Opt-in contract

Export runs only when `FACTORY_COMMAND_OUTPUT_EXPORT=otlp` and the standard OpenTelemetry env allows it. The endpoint
and headers are read from env only; the factory never takes a URL from config or code.

| Variable                                                          | Effect                                                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `FACTORY_COMMAND_OUTPUT_EXPORT`                                   | Must be `otlp`; anything else leaves export off.                                                      |
| `OTEL_SDK_DISABLED`                                               | `true` vetoes the opt-in silently.                                                                    |
| `OTEL_LOGS_EXPORTER`                                              | Comma list; defaults to `otlp`. `none` vetoes silently; a list without `otlp` vetoes with a warning.  |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT` | At least one is required, otherwise export stays off with a warning.                                  |
| `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`, `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` (default) or `http/json`. `grpc` is not supported and disables export with a warning. |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_LOGS_HEADERS`   | Request headers, read by the exporter. Values are never logged.                                       |
| `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_EXPORTER_OTLP_LOGS_TIMEOUT`   | Per-request timeout, capped at 2 s.                                                                   |
| `OTEL_SERVICE_NAME`                                               | `service.name` resource attribute; defaults to `software-factory`.                                    |

A warning is a `command_output_export_degraded` event naming env vars, never values. The run goes on without export.

## Attributes

Each record is an OTLP log record with the line as its body, severity INFO for stdout and WARN for stderr, and the
attributes `factory.run_id`, `factory.issue`, `factory.lane`, `factory.phase`, `factory.command_id`, `factory.seq` and
`log.iostream` (`stdout` or `stderr`), plus `factory.session_id` (see Sessions).

## Sessions

Each CHECK export is a session with an 8-character `factory.session_id`. The session opens with a `session start`
record and closes with a `session end` record, so a collector can tell a complete export from a cut-off one. Both
carry `factory.run_id`, `factory.issue`, `factory.lane`, `factory.phase`, `factory.session_id` and `factory.event`
(`session.start` or `session.end`). The end record adds `factory.session.status`:

- `ok`: the phase finished.
- `error`: the phase threw.
- `interrupted`: SIGINT or SIGTERM ended the session; `factory.signal` names the signal.

A session with no `session.end` record was lost. With export off no session exists.

## Shutdown

On normal exit the session end is flushed within the 5 s budget below. On the first Ctrl-C or SIGTERM, after the agent
process-group sweep, the factory flushes pending records for up to 2 s (a 3 s outer guard also covers the 500 ms
exporter shutdown) and still exits 130. Loss is printed to stderr
(`factory: command output export incomplete for run <id>: <D> dropped, <F> failed`, or a flush timeout line) and logged
as `command_output_export_degraded`. A second signal exits immediately without a flush.

## Bounds

- In-memory queue of 2048 records; records past it are dropped and counted.
- Batches of 256 records, flushed after 200 ms of linger, one batch in flight at a time so order is kept.
- 3 attempts per batch with 250 ms → 500 ms → up to 4 s backoff; a batch that still fails is counted failed.
- 2 s exporter request timeout.
- 5 s flush budget at the end of CHECK (2 s when a signal ends the session); records still unsent then count as failed, then the exporter shuts down
  (500 ms at most). A broken collector can never fail a run or stall it beyond this.

## Events

One event per session reports the totals: `command output export: N sent, D dropped, F failed (R retries)`.

- `command_output_export` (info): nothing was dropped or failed.
- `command_output_export_degraded` (warn): `D + F > 0`, the session was interrupted by a signal (the message ends
  `; session interrupted by <signal>`), or the opt-in was refused or setup failed.

Every record is counted exactly once as sent, dropped (queue full) or failed (retries or the flush budget exhausted).

## Why a custom processor

The official OpenTelemetry JS SDK (`LoggerProvider` and the OTLP log exporters) builds and ships the records. The
SDK's `BatchLogRecordProcessor` drops records silently when its queue is full or an export fails. A small processor
feeds the bounded queue above instead, so loss is counted and reported.

## Local manual check

Run a generic OpenTelemetry Collector with an OTLP/HTTP receiver and a debug exporter on `127.0.0.1:4318`, then:

```sh
FACTORY_COMMAND_OUTPUT_EXPORT=otlp OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 factory run
```

The redacted lines appear in the collector output and the CHECK phase logs a `command_output_export` event with the counts.
