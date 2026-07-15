import { useEffect, useState, type JSX } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { followEvents, type FactoryEvent } from '@on-par/factory-core';
import { initialState, reduceEvent, type RunState } from '../state.js';
import { Header } from './Header.js';
import { PhaseRow } from './PhaseRow.js';
import { EventFeed } from './EventFeed.js';

export interface AppProps {
  eventsFile: string;
  repo?: string;
  follow?: typeof followEvents;
}

export function App({ eventsFile, repo, follow = followEvents }: AppProps): JSX.Element {
  const { exit } = useApp();
  const [state, setState] = useState<RunState>(initialState());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const stop = follow(eventsFile, (e: FactoryEvent) => setState(s => reduceEvent(s, e)), { fromStart: true });
    return stop;
  }, [eventsFile, follow]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, []);

  useInput(input => {
    if (input === 'q') exit();
  });

  const hasEvents = state.feed.length > 0;

  return (
    <Box flexDirection="column">
      <Header issue={state.issue} repo={repo} done={state.done} />
      {hasEvents ? <PhaseRow state={state} now={now} /> : <Text dimColor>waiting for factory events…</Text>}
      <EventFeed events={state.feed} />
    </Box>
  );
}
