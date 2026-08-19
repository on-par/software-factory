# @on-par/factory-server

Local HTTP server for the factory. It exposes exactly one route, `GET /events`,
which relays the lane lifecycle bus (`packages/core/src/bus/index.ts`, #591) as a
Server-Sent Events stream. No auth, no control endpoints, no WebSocket.

The package is marked `"private": true` in `package.json` and is intentionally
excluded from any release or publish path.

## Usage

```ts
import { createServer } from '@on-par/factory-server';
import { lifecycleBus } from '@on-par/factory-core';

const server = createServer({ bus: lifecycleBus, port: 8787 });
const port = await server.start();
// ...
await server.stop();
```

```bash
curl -N http://127.0.0.1:8787/events
```

Each event arrives as an SSE frame with a strictly increasing integer `id:`. A
client that reconnects with a `Last-Event-ID: N` header is replayed every
retained event with an id greater than `N` before the stream goes live — the
server keeps the last `replayBufferSize` events (default 256) in an in-memory
ring. The buffer is bounded and per-process: a client offline for longer than
that many events sees a gap, and ids are not stable across restarts.

**No auth — loopback only, do not expose.** The server binds `127.0.0.1` by
default and `/events` is unauthenticated; do not bind it to a non-loopback
host or put it behind a public proxy.

## Phase 2 (planned)

Beyond this read-only stream, the planned roadmap adds control endpoints
(pause/approve a lane), auth, and eventually webhook triggers that run factory
pipeline jobs through `@on-par/factory-core` in sandboxed environments — see
#583 for the next slice.
