import { useEffect, useState, type JSX } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { existsSync } from 'node:fs';
import { followEvents, type FactoryEvent } from '@on-par/factory-core';
import { initialDashboard, reduceDashboard, type DashboardState } from '../dashboard.js';
import { Header } from './Header.js';
import { Dashboard } from './Dashboard.js';
import { RunDetail } from './RunDetail.js';
import { StopBanner } from './StopBanner.js';

export interface AppProps {
  eventsFile: string;
  repo?: string;
  follow?: typeof followEvents;
  stopFile?: string;
  pathExists?: (p: string) => boolean;
}

type View = 'dashboard' | 'detail';

export function App({ eventsFile, repo, follow = followEvents, stopFile, pathExists = existsSync }: AppProps): JSX.Element {
  const { exit } = useApp();
  const [state, setState] = useState<DashboardState>(initialDashboard());
  const [now, setNow] = useState(Date.now());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [view, setView] = useState<View>('dashboard');
  const [stopFlag, setStopFlag] = useState(false);

  useEffect(() => {
    const stop = follow(eventsFile, (e: FactoryEvent) => setState(s => reduceDashboard(s, e)), { fromStart: true });
    return stop;
  }, [eventsFile, follow]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!stopFile) return;
    const interval = setInterval(() => setStopFlag(pathExists(stopFile)), 1500);
    return () => clearInterval(interval);
  }, [stopFile, pathExists]);

  useInput((input, key) => {
    if (input === 'q') {
      exit();
      return;
    }
    if (view === 'dashboard') {
      if (key.upArrow) setSelectedIndex(i => Math.max(0, i - 1));
      if (key.downArrow) setSelectedIndex(i => Math.min(state.lanes.length - 1, i + 1));
      if (key.return) setView('detail');
    } else if (key.escape) {
      setView('dashboard');
    }
  });

  const stopReason = stopFlag || state.usageStop ? (state.usageStop ?? 'STOP flag present (.factory/STOP)') : undefined;
  const clampedIndex = Math.min(selectedIndex, Math.max(0, state.lanes.length - 1));

  if (state.lanes.length === 0) {
    return (
      <Box flexDirection="column">
        <Header repo={repo} done={false} />
        <Text dimColor>waiting for factory events…</Text>
      </Box>
    );
  }

  if (state.lanes.length === 1) {
    return (
      <Box flexDirection="column">
        {stopReason && <StopBanner reason={stopReason} />}
        <RunDetail run={state.lanes[0].run} repo={repo} now={now} />
      </Box>
    );
  }

  return view === 'dashboard' ? (
    <Dashboard state={state} selectedIndex={clampedIndex} now={now} repo={repo} stopReason={stopReason} />
  ) : (
    <RunDetail run={state.lanes[clampedIndex].run} repo={repo} now={now} showBackHint />
  );
}
