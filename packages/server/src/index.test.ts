import { EventEmitter } from 'node:events';
import http from 'node:http';
import type net from 'node:net';

import type { LaneLifecycleEvent } from '@on-par/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createServer,
  type FactoryServer,
  type LaneController,
  type LifecycleEventSource,
  type ServerConfig,
  SERVER_VERSION,
} from './index.js';
import type { RepositoryLifecycleEvent } from './sse.js';

const SOUND_BUDDY_REPO = 'on-par/sound-buddy';
const OTHER_APP_REPO = 'on-par/other-app';

interface FakeBus extends LifecycleEventSource {
  emit(event: LaneLifecycleEvent): void;
}

interface FakeLaneController extends LaneController {
  pauseCalls: string[];
}

function createFakeBus(): FakeBus {
  const listeners = new Set<(event: LaneLifecycleEvent) => void>();
  return {
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
  };
}

function createFakeLaneController(): FakeLaneController {
  const pauseCalls: string[] = [];
  return {
    pauseCalls,
    pause(laneId) {
      pauseCalls.push(laneId);
    },
  };
}

function attachRepository(repo: string, source: LifecycleEventSource, controller = createFakeLaneController()) {
  return { repo, source, controller };
}

function createTestServer(
  bus: LifecycleEventSource,
  overrides: Omit<ServerConfig, 'repositories'> = {},
): FactoryServer {
  return createServer({ repositories: [attachRepository(SOUND_BUDDY_REPO, bus)], ...overrides });
}

function makeEvent(overrides: Partial<LaneLifecycleEvent> = {}): LaneLifecycleEvent {
  return {
    ts: '2026-08-19T00:00:00.000Z',
    laneId: 'issue-1',
    issueId: '1',
    phase: 'build',
    status: 'started',
    detail: 'event',
    worktreePath: '/tmp/worktree',
    ...overrides,
  };
}

function openRequest(
  port: number,
  path: string,
  options: http.RequestOptions = {},
): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', ...options }, (res) => {
      resolve({ req, res });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Accumulates response chunks and resolves once `count` lifecycle event frames
 *  (those starting with `id: `) have arrived, ignoring `retry:`/`: ping` frames. */
function readFrames(res: http.IncomingMessage, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const frames: string[] = [];
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx + 2);
        buffer = buffer.slice(idx + 2);
        if (frame.startsWith('id: ')) {
          frames.push(frame);
          if (frames.length >= count) {
            resolve(frames);
            return;
          }
        }
      }
    });
    res.on('error', reject);
  });
}

function frameId(frame: string): number {
  return Number(frame.match(/^id: (\d+)/)?.[1]);
}

function frameEvent(frame: string): RepositoryLifecycleEvent {
  const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine!.slice('data: '.length));
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

describe('@on-par/factory-server', () => {
  let server: FactoryServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('exports a semver-shaped SERVER_VERSION', () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('relays live events in order with strictly increasing ids', async () => {
    const bus = createFakeBus();
    server = createTestServer(bus, { port: 0 });
    await server.start();

    const { res } = await openRequest(server.port, '/events');
    expect(res.statusCode).toBe(200);
    const framesPromise = readFrames(res, 3);

    const events = [makeEvent({ detail: 'a' }), makeEvent({ detail: 'b' }), makeEvent({ detail: 'c' })];
    for (const event of events) bus.emit(event);

    const frames = await framesPromise;
    expect(frames.map(frameId)).toEqual([1, 2, 3]);
    expect(frames.map(frameEvent)).toEqual(events.map((event) => ({ ...event, repo: SOUND_BUDDY_REPO })));
  });

  it('filters replay and live events to the selected attached repository', async () => {
    const soundBuddy = createFakeBus();
    const otherApp = createFakeBus();
    server = createServer({
      repositories: [attachRepository(SOUND_BUDDY_REPO, soundBuddy), attachRepository(OTHER_APP_REPO, otherApp)],
      port: 0,
    });
    await server.start();

    otherApp.emit(makeEvent({ detail: 'other replay' }));
    soundBuddy.emit(makeEvent({ detail: 'sound buddy replay' }));

    const { res } = await openRequest(server.port, `/events?repo=${SOUND_BUDDY_REPO}`, {
      headers: { 'last-event-id': '0' },
    });
    expect(res.statusCode).toBe(200);
    const framesPromise = readFrames(res, 1);

    const [frame] = await framesPromise;
    expect(frameId(frame)).toBe(1);
    expect(frameEvent(frame)).toEqual({ ...makeEvent({ detail: 'sound buddy replay' }), repo: SOUND_BUDDY_REPO });

    const live = readFrames(res, 1);
    otherApp.emit(makeEvent({ detail: 'other live' }));
    soundBuddy.emit(makeEvent({ detail: 'sound buddy live' }));
    expect(frameEvent((await live)[0])).toEqual({
      ...makeEvent({ detail: 'sound buddy live' }),
      repo: SOUND_BUDDY_REPO,
    });
  });

  it('relays every attached repository on an unfiltered stream', async () => {
    const soundBuddy = createFakeBus();
    const otherApp = createFakeBus();
    server = createServer({
      repositories: [attachRepository(SOUND_BUDDY_REPO, soundBuddy), attachRepository(OTHER_APP_REPO, otherApp)],
      port: 0,
    });
    await server.start();

    const { res } = await openRequest(server.port, '/events');
    expect(res.statusCode).toBe(200);
    const framesPromise = readFrames(res, 2);
    soundBuddy.emit(makeEvent({ detail: 'sound buddy' }));
    otherApp.emit(makeEvent({ detail: 'other app' }));

    const frames = await framesPromise;
    expect(frames.map(frameId)).toEqual([1, 1]);
    expect(frames.map(frameEvent)).toEqual([
      { ...makeEvent({ detail: 'sound buddy' }), repo: SOUND_BUDDY_REPO },
      { ...makeEvent({ detail: 'other app' }), repo: OTHER_APP_REPO },
    ]);
  });

  it('resumes a filtered repository stream without unrelated traffic advancing its cursor', async () => {
    const soundBuddy = createFakeBus();
    const otherApp = createFakeBus();
    server = createServer({
      repositories: [attachRepository(SOUND_BUDDY_REPO, soundBuddy), attachRepository(OTHER_APP_REPO, otherApp)],
      port: 0,
    });
    await server.start();

    const { req: req1, res: res1 } = await openRequest(server.port, `/events?repo=${SOUND_BUDDY_REPO}`);
    const first = readFrames(res1, 1);
    soundBuddy.emit(makeEvent({ detail: 'sound buddy 1' }));
    expect((await first).map(frameId)).toEqual([1]);
    req1.destroy();

    otherApp.emit(makeEvent({ detail: 'other app 1' }));
    otherApp.emit(makeEvent({ detail: 'other app 2' }));
    soundBuddy.emit(makeEvent({ detail: 'sound buddy 2' }));

    const { res: res2 } = await openRequest(server.port, `/events?repo=${SOUND_BUDDY_REPO}`, {
      headers: { 'last-event-id': '1' },
    });
    const frames = await readFrames(res2, 1);
    expect(frames.map(frameId)).toEqual([2]);
    expect(frames.map(frameEvent)).toEqual([{ ...makeEvent({ detail: 'sound buddy 2' }), repo: SOUND_BUDDY_REPO }]);
  });

  it('resumes a firehose stream with the cursor applied independently to every repository', async () => {
    const soundBuddy = createFakeBus();
    const otherApp = createFakeBus();
    server = createServer({
      repositories: [attachRepository(SOUND_BUDDY_REPO, soundBuddy), attachRepository(OTHER_APP_REPO, otherApp)],
      port: 0,
    });
    await server.start();

    const { req: req1, res: res1 } = await openRequest(server.port, '/events');
    const first = readFrames(res1, 1);
    soundBuddy.emit(makeEvent({ detail: 'sound buddy 1' }));
    expect((await first).map(frameId)).toEqual([1]);
    req1.destroy();

    otherApp.emit(makeEvent({ detail: 'other app 1' }));
    soundBuddy.emit(makeEvent({ detail: 'sound buddy 2' }));
    otherApp.emit(makeEvent({ detail: 'other app 2' }));

    const { res: res2 } = await openRequest(server.port, '/events', { headers: { 'last-event-id': '1' } });
    const frames = await readFrames(res2, 2);
    expect(frames.map(frameId)).toEqual([2, 2]);
    expect(frames.map(frameEvent)).toEqual([
      { ...makeEvent({ detail: 'sound buddy 2' }), repo: SOUND_BUDDY_REPO },
      { ...makeEvent({ detail: 'other app 2' }), repo: OTHER_APP_REPO },
    ]);
  });

  it('uses a filtered cursor when reconnecting to the firehose', async () => {
    const soundBuddy = createFakeBus();
    const otherApp = createFakeBus();
    server = createServer({
      repositories: [attachRepository(SOUND_BUDDY_REPO, soundBuddy), attachRepository(OTHER_APP_REPO, otherApp)],
      port: 0,
    });
    await server.start();

    const { req: req1, res: res1 } = await openRequest(server.port, `/events?repo=${SOUND_BUDDY_REPO}`);
    const first = readFrames(res1, 1);
    soundBuddy.emit(makeEvent({ detail: 'sound buddy 1' }));
    expect((await first).map(frameId)).toEqual([1]);
    req1.destroy();

    otherApp.emit(makeEvent({ detail: 'other app 1' }));
    soundBuddy.emit(makeEvent({ detail: 'sound buddy 2' }));
    otherApp.emit(makeEvent({ detail: 'other app 2' }));

    const { res: res2 } = await openRequest(server.port, '/events', { headers: { 'last-event-id': '1' } });
    const frames = await readFrames(res2, 2);
    expect(frames.map(frameId)).toEqual([2, 2]);
    expect(frames.map(frameEvent)).toEqual([
      { ...makeEvent({ detail: 'sound buddy 2' }), repo: SOUND_BUDDY_REPO },
      { ...makeEvent({ detail: 'other app 2' }), repo: OTHER_APP_REPO },
    ]);
  });

  it('rejects an unattached repository selector before opening an SSE stream', async () => {
    const soundBuddy = createFakeBus();
    const otherApp = createFakeBus();
    server = createServer({
      repositories: [attachRepository(SOUND_BUDDY_REPO, soundBuddy), attachRepository(OTHER_APP_REPO, otherApp)],
      port: 0,
    });
    await server.start();

    const { res } = await openRequest(server.port, '/events?repo=on-par/nope');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['x-accel-buffering']).toBeUndefined();
    expect(await readBody(res)).toBe(JSON.stringify({ error: 'repository not attached' }));
    expect(res.complete).toBe(true);
  });

  it('pauses a lane through only the controller attached to the named repository', async () => {
    const soundBuddy = createFakeBus();
    const otherApp = createFakeBus();
    const soundBuddyController = createFakeLaneController();
    const otherAppController = createFakeLaneController();
    server = createServer({
      repositories: [
        attachRepository(SOUND_BUDDY_REPO, soundBuddy, soundBuddyController),
        attachRepository(OTHER_APP_REPO, otherApp, otherAppController),
      ],
      port: 0,
    });
    await server.start();

    const { res } = await openRequest(server.port, '/repos/on-par/sound-buddy/lanes/lane-1/pause', {
      method: 'POST',
    });

    expect(res.statusCode).toBe(204);
    expect(await readBody(res)).toBe('');
    expect(soundBuddyController.pauseCalls).toEqual(['lane-1']);
    expect(otherAppController.pauseCalls).toEqual([]);
  });

  it('rejects a pause request for an unattached repository without calling a controller', async () => {
    const soundBuddy = createFakeBus();
    const otherApp = createFakeBus();
    const soundBuddyController = createFakeLaneController();
    const otherAppController = createFakeLaneController();
    server = createServer({
      repositories: [
        attachRepository(SOUND_BUDDY_REPO, soundBuddy, soundBuddyController),
        attachRepository(OTHER_APP_REPO, otherApp, otherAppController),
      ],
      port: 0,
    });
    await server.start();

    const { res } = await openRequest(server.port, '/repos/on-par/nope/lanes/lane-1/pause', { method: 'POST' });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('application/json');
    expect(await readBody(res)).toBe(JSON.stringify({ error: 'repository not attached' }));
    expect(soundBuddyController.pauseCalls).toEqual([]);
    expect(otherAppController.pauseCalls).toEqual([]);
  });

  it('resumes from Last-Event-ID after a disconnect', async () => {
    const bus = createFakeBus();
    server = createTestServer(bus, { port: 0 });
    await server.start();

    const { req: req1, res: res1 } = await openRequest(server.port, '/events');
    const first = readFrames(res1, 2);
    bus.emit(makeEvent({ detail: '1' }));
    bus.emit(makeEvent({ detail: '2' }));
    await first;
    req1.destroy();

    bus.emit(makeEvent({ detail: '3' }));

    const { res: res2 } = await openRequest(server.port, '/events', {
      headers: { 'last-event-id': '2' },
    });
    expect(res2.statusCode).toBe(200);
    const replayed = await readFrames(res2, 1);
    expect(replayed.map(frameId)).toEqual([3]);

    const live = readFrames(res2, 1);
    bus.emit(makeEvent({ detail: '4' }));
    const liveFrames = await live;
    expect(liveFrames.map(frameId)).toEqual([4]);
  });

  it('replays the whole ring for a cursor older than the oldest retained id', async () => {
    const bus = createFakeBus();
    server = createTestServer(bus, { port: 0, replayBufferSize: 2 });
    await server.start();

    for (let i = 0; i < 5; i++) bus.emit(makeEvent({ detail: String(i) }));

    const { res } = await openRequest(server.port, '/events', { headers: { 'last-event-id': '1' } });
    expect(res.statusCode).toBe(200);
    const frames = await readFrames(res, 2);
    expect(frames.map(frameId)).toEqual([4, 5]);
  });

  it('treats a malformed Last-Event-ID as no replay and keeps the stream live', async () => {
    const bus = createFakeBus();
    server = createTestServer(bus, { port: 0 });
    await server.start();

    const { res } = await openRequest(server.port, '/events', {
      headers: { 'last-event-id': 'not-a-number' },
    });
    expect(res.statusCode).toBe(200);

    const framesPromise = readFrames(res, 1);
    bus.emit(makeEvent({ detail: 'live' }));
    const frames = await framesPromise;
    expect(frames.map(frameId)).toEqual([1]);
  });

  it('binds 127.0.0.1 by default, and explicitly, never 0.0.0.0', async () => {
    const bus = createFakeBus();
    server = createTestServer(bus, { port: 0 });
    await server.start();
    const addr = server.server.address() as net.AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.address).not.toBe('0.0.0.0');
    await server.stop();

    const explicit = createTestServer(bus, { port: 0, host: '127.0.0.1' });
    await explicit.start();
    const explicitAddr = explicit.server.address() as net.AddressInfo;
    expect(explicitAddr.address).toBe('127.0.0.1');
    await explicit.stop();
  });

  it('answers unknown routes and non-GET/HEAD methods on /events with 404 JSON', async () => {
    const bus = createFakeBus();
    server = createTestServer(bus, { port: 0 });
    await server.start();

    const { res: nope } = await openRequest(server.port, '/nope');
    expect(nope.statusCode).toBe(404);
    const nopeBody = await readBody(nope);
    expect(JSON.parse(nopeBody)).toEqual({ error: 'not found' });

    const { res: posted } = await openRequest(server.port, '/events', { method: 'POST' });
    expect(posted.statusCode).toBe(404);
  });

  it('answers HEAD /events with headers only and no body frames', async () => {
    const bus = createFakeBus();
    server = createTestServer(bus, { port: 0 });
    await server.start();

    const { res } = await openRequest(server.port, '/events', { method: 'HEAD' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    const body = await readBody(res);
    expect(body).toBe('');
  });

  it('writes a heartbeat comment on an idle stream when heartbeatMs > 0', async () => {
    const bus = createFakeBus();
    server = createTestServer(bus, { port: 0, heartbeatMs: 10 });
    await server.start();

    const { res } = await openRequest(server.port, '/events');
    let sawPing = false;
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.includes(': ping')) sawPing = true;
    });
    await waitFor(() => sawPing, 500);
    expect(sawPing).toBe(true);
  });

  it('writes no heartbeat when heartbeatMs is 0', async () => {
    const bus = createFakeBus();
    server = createTestServer(bus, { port: 0, heartbeatMs: 0 });
    await server.start();

    const { res } = await openRequest(server.port, '/events');
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      raw += chunk;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(raw.includes(': ping')).toBe(false);
  });

  it('stop() is idempotent, ends open connections, and unsubscribes from the bus', async () => {
    const bus = createFakeBus();
    server = createTestServer(bus, { port: 0 });
    await server.start();

    const { res } = await openRequest(server.port, '/events');
    res.resume();
    const closed = new Promise<void>((resolve) => res.on('close', resolve));

    await server.stop();
    await closed;
    await expect(server.stop()).resolves.toBeUndefined();

    expect(() => bus.emit(makeEvent())).not.toThrow();
  });

  it('start() resolves with the actually bound port, matching server.port', async () => {
    const bus = createFakeBus();
    server = createTestServer(bus, { port: 0 });
    const resolvedPort = await server.start();
    expect(resolvedPort).toBeGreaterThan(0);
    expect(Number.isInteger(resolvedPort)).toBe(true);
    expect(resolvedPort).toBe(server.port);
  });

  it('start() rejects when the port is already bound', async () => {
    const bus = createFakeBus();
    server = createTestServer(bus, { port: 0 });
    await server.start();

    const conflicting = createTestServer(bus, { port: server.port });
    await expect(conflicting.start()).rejects.toThrow();
  });

  it('defaults to port 8787 when none is configured', () => {
    const bus = createFakeBus();
    server = createTestServer(bus);
    expect(server.port).toBe(8787);
  });

  it('falls back to the desired port when server.address() is not an AddressInfo', async () => {
    const bus = createFakeBus();
    server = createTestServer(bus, { port: 0 });
    vi.spyOn(server.server, 'address').mockReturnValueOnce(null);
    const port = await server.start();
    expect(port).toBe(0);
    expect(server.port).toBe(0);
  });

  it('falls back to the desired port when server.address() returns a pipe string', async () => {
    const bus = createFakeBus();
    server = createTestServer(bus, { port: 0 });
    vi.spyOn(server.server, 'address').mockReturnValueOnce('/tmp/factory.sock');
    const port = await server.start();
    expect(port).toBe(0);
  });

  it('falls back to "/" when req.url is undefined', async () => {
    const bus = createFakeBus();
    server = createTestServer(bus, { port: 0 });
    await server.start();

    const res = { writeHead: vi.fn(), end: vi.fn() };
    const req = { url: undefined, method: 'GET', headers: {} };
    server.server.emit('request', asServerRequest(req), asServerResponse(res));
    expect(res.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
  });

  it('swallows write errors on a response after it has disconnected', async () => {
    const bus = createFakeBus();
    server = createTestServer(bus, { port: 0 });
    await server.start();

    class FakeResponse extends EventEmitter {
      writeHead(): this {
        return this;
      }
      write(): boolean {
        return true;
      }
      end(): void {}
    }
    const res = new FakeResponse();
    const req = Object.assign(new EventEmitter(), { headers: {}, method: 'GET', url: '/events' });

    server.server.emit('request', asServerRequest(req), asServerResponse(res));
    expect(() => res.emit('error', new Error('boom'))).not.toThrow();
  });
});

interface FakeServerRequest {
  url: string | undefined;
  method: string;
  headers: Record<string, string>;
}
interface FakeServerResponse {
  writeHead: (...args: any[]) => any;
  write?: (...args: any[]) => any;
  end: (...args: any[]) => any;
}
/** createServer's request handler only reads url/method/headers and calls writeHead/write/end;
 *  these doubles implement exactly that surface, so widening each costs one assertion. */
function asServerRequest(double: FakeServerRequest): http.IncomingMessage {
  return double as http.IncomingMessage;
}
function asServerResponse(double: FakeServerResponse): http.ServerResponse {
  return double as http.ServerResponse;
}

function readBody(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      body += chunk;
    });
    res.on('end', () => resolve(body));
    res.on('error', reject);
  });
}
