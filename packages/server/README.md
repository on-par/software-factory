# @on-par/factory-server

Local HTTP server for the factory. It exposes `GET /events`, which relays the
lane lifecycle bus (`packages/core/src/bus/index.ts`, #591) as a Server-Sent
Events stream, and `POST /repos/:owner/:repo/lanes/:laneId/pause`, which pauses
a lane through the controller attached to that repository. No auth or WebSocket.

The package is marked `"private": true` in `package.json` and is intentionally
excluded from any release or publish path.

## Usage

```ts
import { createServer } from '@on-par/factory-server';
import { lifecycleBus } from '@on-par/factory-core';

const server = createServer({
  repositories: [
    {
      repo: 'on-par/sound-buddy',
      source: lifecycleBus,
      controller: { pause: (laneId) => pauseLane(laneId) },
    },
  ],
  port: 8787,
});
const port = await server.start();
// ...
await server.stop();
```

```bash
curl -N http://127.0.0.1:8787/events
curl -X POST http://127.0.0.1:8787/repos/on-par/sound-buddy/lanes/lane-1/pause
```

Each event arrives as an SSE frame with a strictly increasing integer `id:`. A
client that reconnects with a `Last-Event-ID: N` header is replayed every
retained event with an id greater than `N` before the stream goes live — the
server keeps the last `replayBufferSize` events (default 256) in an in-memory
ring. The buffer is bounded and per-process: a client offline for longer than
that many events sees a gap, and ids are not stable across restarts.

**No auth — loopback only, do not expose.** The server binds `127.0.0.1` by
default and both `/events` and the repository-qualified pause endpoint are
unauthenticated; do not bind it to a non-loopback host or put it behind a
public proxy.

## Phase 2 (planned)

Beyond the pause endpoint, the planned roadmap adds other controls (such as
approving a lane), auth, and eventually webhook triggers that run factory
pipeline jobs through `@on-par/factory-core` in sandboxed environments — see
#583 for the next slice.
