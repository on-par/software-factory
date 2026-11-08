# ADR-0177: Nested command output exports as redacted OTLP log records only on explicit opt-in, and never includes model output

- Status: Accepted
- Date: 2026-11-08
- See also: [ADR-0145](0145-costentry-fields-export-as-otel-genai-semconv-v1-41-1-attributes-or-factory-attributes-and-an-unpriced-call-omits-cost-and-sets-factory-cost-unpriced.md) (content privacy), [ADR-0004](0004-narrow-public-core-api.md) (internal surface)

## Context

A host that runs the factory CLI usually collects the CLI's own stdout and stderr. The output of the commands the factory starts (checkers, base health, `app_smoke`, lane installs) is not in that stream. It is captured in memory, tailed and cut to excerpts, so a long checker run loses its beginning and middle, and nothing is visible while the command still runs. The opt-in raw NDJSON stream (`FACTORY_COMMAND_STREAM_DIR`) solves this on local disk only, and it is unredacted by contract.

ADR-0145 defines the factory's telemetry model and forbids model input or output in any log record. Agent harness executions run through the same exec seam as checker commands, so a naive output tap would export model output.

## Decision

1. **Route.** The factory CLI process exports nested command output itself as OTLP log records. It uses the official OpenTelemetry JS exporters (`http/protobuf` by default, `http/json`), which also parse the standard `OTEL_EXPORTER_OTLP_*` endpoint, header, timeout and compression variables. gRPC is not supported; asking for it turns export off with one warning.
2. **Explicit opt-in.** Export runs only when `FACTORY_COMMAND_OUTPUT_EXPORT=otlp` is set **and** an endpoint is configured (`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`). `OTEL_SDK_DISABLED=true`, or an `OTEL_LOGS_EXPORTER` list without `otlp` (for example `none`), turns it off. `OTEL_*` alone never turns it on: a host that already sets `OTEL_*` to export the CLI's own stdout must not suddenly receive a second, overlapping stream.
3. **Scope.** Only the pipe output of commands started through the three tapped seams is exported: `runCommand` (attached and process-group paths), the shell exec seam (`defaultExecFn`), and the `app_smoke` app boot. The CLI's own stdout, stderr and logger output are never exported. Other subprocesses (most git and `gh` calls, SHIP, nested `factory` processes) are not tapped.
4. **No model output.** A tap reads its content class from the caller's async context. The harness layer wraps the exec it hands every agent harness once (`modelOutputExec` in the model executor and in `factory harness check`), so any command started inside a harness run (Claude CLI, Codex CLI, Pi, OpenCode, a command harness, Ollama agentic verify commands) is a model execution and is never exported. It is counted as `withheld`. Prompts are never logged. This extends ADR-0145's content-privacy rule to the logs route; it does not change it.
5. **Redaction before the queue.** Each stream is decoded with its own UTF-8 decoder, framed into lines and redacted before anything is queued, so no unredacted byte reaches memory queues, the network or disk. Redaction masks the literal values of credential-like env vars (GitHub credentials and generic `*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`, … names) and of the OTLP header values, then calls the existing GitHub, router and filing secret pattern sets. A line is capped at 16 KiB. A longer line is cut only at whitespace, at least a hold-back before the cap. The hold-back is at least the longest known secret, and a cut is taken only where redacting both halves equals redacting the window. A whitespace-free run too long to cut safely is withheld as `[factory: unbroken run withheld]`. Memory per stream is bounded by the cap. With only OTLP on, nothing new is written to disk.
6. **Delivery accounting.** The factory's own bounded queue (8192 records, 8 MiB) sits in front of the exporter. It calls the exporter's `export()` directly and counts a record delivered only when the result callback reports success. One batch is in flight at a time, so records arrive in order. A transient failure (no HTTP status: network error, timeout, exhausted retryable status) is retried with bounded exponential backoff inside a 30 s window; the exporter itself honours `Retry-After` within its own timeout. A rejection with an HTTP status is permanent and counted. Output past the bounds is dropped and counted per command. Start and end markers have reserved room; a marker that still does not fit is counted as `markers_dropped`. Session start and end are always kept. Pipes are never blocked.
7. **Records.** The resource carries `service.name` (default `factory`, `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` win), `service.version`, `process.pid`, `factory.session.id` (the process tag) and `factory.run.id` when `FACTORY_RUN_ID` is set. The scope is `factory.command_output`. Events: `factory.session.start`, `factory.command.start`, `factory.command.output` (body = one redacted line or segment; `log.iostream`, `factory.command.seq`, `factory.output.offset`, `factory.output.partial`), `factory.command.end` (exit code or signal, bytes and records per stream, `dropped`, `export_failed`, `complete`, `interrupted`) and `factory.session.end` (totals, `reason`, `complete`). `factory.command.id` is the same id the NDJSON file name carries.
8. **Completeness.** A command end record says `complete: true` only when every earlier record of that command was acknowledged and nothing was dropped. The end record is built only after those records settle. A command without an end record, or a session without an end record, is incomplete.
9. **Lifecycle.** The CLI flushes with a 5 s budget when `main()` completes or rejects, and with a 2.5 s budget in the existing signal shutdown path, after its process-group sweep and before it exits 130. One export call is capped at 2 s, and no attempt starts unless it can finish inside the budget. Queue timers are unref'd. Idle exporter sockets do not hold the process. Commands that call `process.exit` themselves, and processes killed without the shutdown handler, do not flush; their tail is incomplete by the rule above. With export off, no OTel package is loaded and no timer, listener or socket is added.

## Consequences

- Positive: a host sees nested command output live, redacted and correlated by session and command id, with explicit loss accounting.
- Positive: model output stays out of every telemetry route.
- Negative: six OpenTelemetry packages are runtime dependencies of `core`.
- Negative: redaction is the factory's rule set; a host's own redaction of the CLI's stdout may differ.
- Negative: git, `gh`, SHIP and nested `factory` processes are not covered. Covering them means routing those call sites through a tap.
- Neutral: the child environment is unchanged. Children still inherit `OTEL_*` variables, including any header credentials, as before this ADR.

## Alternatives considered

- **A separate forwarder process tailing the NDJSON files.** Rejected: raw secrets on disk, an inter-process file protocol, and a second process whose lifetime the CLI must manage.
- **The SDK's batch log processor as the queue.** Rejected: it drops records without per-command counts and does not report acknowledgement per record.
- **Turning export on whenever `OTEL_*` is set.** Rejected: duplicate export for hosts that already collect the CLI's stdout.
