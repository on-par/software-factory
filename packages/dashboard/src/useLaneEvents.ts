import { LaneLifecycleEventSchema } from '@on-par/contracts';
import { useEffect, useState } from 'react';

import { emptyLaneBoard, reduceLaneEvent, type LaneBoardState } from './laneBoardState.js';

export const DEFAULT_EVENTS_URL = '/events';

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface UseLaneEventsOptions {
  url?: string;
  createEventSource?: EventSourceFactory;
}

export interface UseLaneEventsResult {
  board: LaneBoardState;
  connected: boolean;
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
  const [connected, setConnected] = useState(false);
  const url = options.url ?? DEFAULT_EVENTS_URL;
  const factory = options.createEventSource ?? createBrowserEventSource;

  useEffect(() => {
    const source = factory(url);

    source.addEventListener('open', () => setConnected(true));
    source.addEventListener('error', () => setConnected(false));
    source.addEventListener('lifecycle', (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(event.data as string);
      } catch {
        return;
      }
      const parsed = LaneLifecycleEventSchema.safeParse(raw);
      if (!parsed.success) return;
      setBoard((prev) => reduceLaneEvent(prev, parsed.data));
    });

    return () => source.close();
  }, [url, factory]);

  return { board, connected };
}
