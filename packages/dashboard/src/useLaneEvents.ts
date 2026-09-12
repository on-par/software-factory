import { LaneLifecycleEventSchema, RepositoryLaneLifecycleEventSchema } from '@on-par/contracts';
import { useEffect, useState } from 'react';

import { emptyLaneBoard, readEventRepo, reduceLaneEvent, type LaneBoardState } from './laneBoardState.js';
import { DEFAULT_EVENTS_URL, repoEventsUrl, reduceRepoLaneEvent } from './repoDetailState.js';

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export type ConnectionState = 'connecting' | 'live' | 'disconnected';

export interface UseLaneEventsOptions {
  url?: string;
  /** When set, subscribes to the repo-scoped stream and drops frames from any other repo. */
  repo?: string;
  createEventSource?: EventSourceFactory;
}

export interface UseLaneEventsResult {
  board: LaneBoardState;
  connection: ConnectionState;
}

export function createBrowserEventSource(url: string): EventSourceLike {
  if (typeof globalThis.EventSource === 'undefined') {
    return {
      addEventListener() {},
      close() {},
    };
  }
  return new EventSource(url);
}

export function useLaneEvents(options: UseLaneEventsOptions = {}): UseLaneEventsResult {
  const [board, setBoard] = useState<LaneBoardState>(emptyLaneBoard);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const repo = options.repo;
  const url = options.url ?? (repo === undefined ? DEFAULT_EVENTS_URL : repoEventsUrl(repo));
  const factory = options.createEventSource ?? createBrowserEventSource;

  useEffect(() => {
    const source = factory(url);

    source.addEventListener('open', () => setConnection('live'));
    source.addEventListener('error', () => setConnection('disconnected'));
    source.addEventListener('lifecycle', (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (repo === undefined) {
        const parsed = LaneLifecycleEventSchema.safeParse(raw);
        if (!parsed.success) return;
        const eventRepo = readEventRepo(raw);
        setBoard((prev) =>
          reduceLaneEvent(prev, eventRepo === undefined ? parsed.data : { ...parsed.data, repo: eventRepo }),
        );
        return;
      }
      const parsed = RepositoryLaneLifecycleEventSchema.safeParse(raw);
      if (!parsed.success) return;
      setBoard((prev) => reduceRepoLaneEvent(prev, repo, parsed.data));
    });

    return () => source.close();
  }, [url, repo, factory]);

  return { board, connection };
}
