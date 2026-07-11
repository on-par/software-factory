# @on-par/factory-server

**Unimplemented Phase-2 stub — do not use.**

This package does not contain a working server yet. `createServer()` currently
throws `Error('Server not yet implemented — see SaaS roadmap in README')`.

The package is marked `"private": true` in `package.json` and is intentionally
excluded from any release or publish path.

## Phase 2 (planned)

The planned server will receive GitHub webhook triggers, run factory pipeline
jobs through `@on-par/factory-core`, execute work in sandboxed Docker or Daytona
environments, and use a job queue to manage concurrent runs.
