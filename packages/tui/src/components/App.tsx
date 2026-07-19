import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  aggregateCosts,
  type ApprovalRequest,
  type CostsRead,
  extractPathCandidates,
  type FactoryEvent,
  followEvents,
  listPendingApprovals,
  listQueuedSteering,
  type QueueSnapshot,
  queueSteeringMessage,
  readCostsFile,
  readQueue,
  respondToApproval,
} from '@on-par/factory-core';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { type JSX, useEffect, useMemo, useState } from 'react';

import { type DashboardState, initialDashboard, reduceDashboard } from '../dashboard.js';
import { CostsTab } from '../tabs/CostsTab.js';
import { initialLogScroll, reduceLogScroll } from '../tabs/log-scroll.js';
import { LogTab } from '../tabs/LogTab.js';
import { QueueTab } from '../tabs/QueueTab.js';
import { TabBar } from '../tabs/TabBar.js';
import { TAB_ORDER, type TabName } from '../tabs/types.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { Dashboard } from './Dashboard.js';
import { Header } from './Header.js';
import { RunDetail } from './RunDetail.js';
import { SteeringComposer } from './SteeringComposer.js';
import { StopBanner } from './StopBanner.js';

const MAX_LOG_EVENTS = 5000;
const POLL_MS = 2000;

export interface AppProps {
  eventsFile: string;
  repo?: string;
  follow?: typeof followEvents;
  stopFile?: string;
  pathExists?: (p: string) => boolean;
  queueFile?: string;
  queueProposedFile?: string;
  costsFile?: string;
  readQueueFn?: typeof readQueue;
  readCostsFn?: typeof readCostsFile;
  approvalsDir?: string;
  listPendingFn?: typeof listPendingApprovals;
  respondFn?: typeof respondToApproval;
  steeringDir?: string;
  queueSteeringFn?: typeof queueSteeringMessage;
  listSteeringFn?: typeof listQueuedSteering;
}

type View = 'dashboard' | 'detail';

interface ComposerState {
  issue: string;
  worktree?: string;
  text: string;
  warned: boolean;
}

export function App({
  eventsFile,
  repo,
  follow = followEvents,
  stopFile,
  pathExists = existsSync,
  queueFile,
  queueProposedFile,
  costsFile,
  readQueueFn = readQueue,
  readCostsFn = readCostsFile,
  approvalsDir,
  listPendingFn = listPendingApprovals,
  respondFn = respondToApproval,
  steeringDir,
  queueSteeringFn = queueSteeringMessage,
  listSteeringFn = listQueuedSteering,
}: AppProps): JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<DashboardState>(initialDashboard());
  const [events, setEvents] = useState<FactoryEvent[]>([]);
  const [now, setNow] = useState(Date.now());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [view, setView] = useState<View>('dashboard');
  const [stopFlag, setStopFlag] = useState(false);
  const [tab, setTab] = useState<TabName>('dashboard');
  const [queueSnap, setQueueSnap] = useState<QueueSnapshot>({ entries: [] });
  const [costsRead, setCostsRead] = useState<CostsRead>({ entries: [], skipped: 0 });
  const [costsSelected, setCostsSelected] = useState(0);
  const [logScroll, setLogScroll] = useState(initialLogScroll());
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [denyReason, setDenyReason] = useState<string | undefined>(undefined);
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [composer, setComposer] = useState<ComposerState | undefined>(undefined);
  const [steeringQueued, setSteeringQueued] = useState<Record<string, number>>({});

  useEffect(() => {
    const stop = follow(
      eventsFile,
      (e: FactoryEvent) => {
        setState((s) => reduceDashboard(s, e));
        setEvents((prev) => (prev.length >= MAX_LOG_EVENTS ? [...prev.slice(1), e] : [...prev, e]));
      },
      { fromStart: true },
    );
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

  useEffect(() => {
    if (!queueFile) return;
    const read = () => setQueueSnap(readQueueFn(queueFile, queueProposedFile));
    read();
    const interval = setInterval(read, POLL_MS);
    return () => clearInterval(interval);
  }, [queueFile, queueProposedFile, readQueueFn]);

  useEffect(() => {
    if (!costsFile) return;
    const read = () => setCostsRead(readCostsFn(costsFile));
    read();
    const interval = setInterval(read, POLL_MS);
    return () => clearInterval(interval);
  }, [costsFile, readCostsFn]);

  useEffect(() => {
    if (!approvalsDir) return;
    const read = () => setPendingApprovals(listPendingFn(approvalsDir));
    read();
    const interval = setInterval(read, POLL_MS);
    return () => clearInterval(interval);
  }, [approvalsDir, listPendingFn]);

  const laneIssuesKey = state.lanes.map((l) => l.issue).join(',');

  useEffect(() => {
    if (!steeringDir) return;
    const read = () => {
      const counts: Record<string, number> = {};
      for (const lane of state.lanes) {
        counts[lane.issue] = listSteeringFn(steeringDir, Number(lane.issue)).length;
      }
      setSteeringQueued(counts);
    };
    read();
    const interval = setInterval(read, POLL_MS);
    return () => clearInterval(interval);
    // laneIssuesKey (not state.lanes) is the dep: it only changes when the set of
    // issues changes, so this poll doesn't tear down/reinstall on every factory event.
  }, [steeringDir, listSteeringFn, laneIssuesKey]);

  const issueCount = useMemo(() => aggregateCosts(costsRead.entries).perIssue.length, [costsRead]);
  const logHeight = Math.max(5, (stdout?.rows ?? 24) - 4);
  const visibleApprovals = pendingApprovals.filter((r) => !answered.has(r.id));
  const clampedIndex = Math.min(selectedIndex, Math.max(0, state.lanes.length - 1));

  useInput((input, key) => {
    if (composer) {
      if (key.escape) {
        setComposer(undefined);
        return;
      }
      if (key.return) {
        const missing = extractPathCandidates(composer.text).filter(
          (p) => composer.worktree && !pathExists(join(composer.worktree, p)),
        );
        if (missing.length > 0 && !composer.warned) {
          setComposer((c) => (c ? { ...c, warned: true } : c));
          return;
        }
        if (composer.text.length > 0) {
          queueSteeringFn(steeringDir!, Number(composer.issue), composer.text);
        }
        setComposer(undefined);
        return;
      }
      if (key.backspace || key.delete) {
        setComposer((c) => (c ? { ...c, text: c.text.slice(0, -1) } : c));
        return;
      }
      if (input && input.length > 1) {
        // eslint-disable-next-line no-control-regex -- stripping bracketed-paste markers
        const cleaned = input.replace(/\x1b\[200~|\x1b\[201~/g, '').replace(/\r\n|\r/g, '\n');
        setComposer((c) => (c ? { ...c, text: c.text + cleaned, warned: false } : c));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setComposer((c) => (c ? { ...c, text: c.text + input, warned: false } : c));
      }
      return;
    }

    if (denyReason !== undefined) {
      const active = visibleApprovals[0];
      if (key.return) {
        if (active) {
          respondFn(approvalsDir!, active.id, { approved: false, reason: denyReason.trim() || undefined });
          setAnswered((prev) => new Set(prev).add(active.id));
        }
        setDenyReason(undefined);
        return;
      }
      if (key.escape) {
        setDenyReason(undefined);
        return;
      }
      if (key.backspace || key.delete) {
        setDenyReason((reason) => (reason ?? '').slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setDenyReason((reason) => (reason ?? '') + input);
      }
      return;
    }

    if (visibleApprovals.length > 0) {
      const active = visibleApprovals[0];
      if (input === 'y') {
        respondFn(approvalsDir!, active.id, { approved: true });
        setAnswered((prev) => new Set(prev).add(active.id));
        return;
      }
      if (input === 'n') {
        setDenyReason('');
        return;
      }
    }

    if (
      tab === 'dashboard' &&
      steeringDir &&
      input === 'i' &&
      state.lanes.length > 0 &&
      visibleApprovals.length === 0
    ) {
      const activeLane = state.lanes[clampedIndex];
      if (activeLane) {
        setComposer({ issue: activeLane.issue, worktree: activeLane.worktree, text: '', warned: false });
      }
      return;
    }

    if (input === 'q') {
      exit();
      return;
    }
    if (key.tab) {
      setTab((t) => TAB_ORDER[(TAB_ORDER.indexOf(t) + 1) % TAB_ORDER.length]);
      setView('dashboard');
      return;
    }
    const digit = Number(input);
    if (Number.isInteger(digit) && digit >= 1 && digit <= TAB_ORDER.length) {
      setTab(TAB_ORDER[digit - 1]);
      setView('dashboard');
      return;
    }

    if (tab === 'dashboard') {
      if (view === 'dashboard') {
        if (key.upArrow) setSelectedIndex((i) => Math.max(0, i - 1));
        if (key.downArrow) setSelectedIndex((i) => Math.min(state.lanes.length - 1, i + 1));
        if (key.return) setView('detail');
      } else if (key.escape) {
        setView('dashboard');
      }
    } else if (tab === 'costs') {
      if (key.upArrow) setCostsSelected((i) => Math.max(0, i - 1));
      if (key.downArrow) setCostsSelected((i) => Math.min(Math.max(0, issueCount - 1), i + 1));
    } else if (tab === 'log') {
      if (key.upArrow) setLogScroll((s) => reduceLogScroll(s, 'up', logHeight, events.length));
      if (key.downArrow) setLogScroll((s) => reduceLogScroll(s, 'down', logHeight, events.length));
      if (key.pageUp) setLogScroll((s) => reduceLogScroll(s, 'pageUp', logHeight, events.length));
      if (key.pageDown) setLogScroll((s) => reduceLogScroll(s, 'pageDown', logHeight, events.length));
      if (input === 'f') setLogScroll((s) => reduceLogScroll(s, 'toggleFollow', logHeight, events.length));
    }
  });

  const stopReason = stopFlag || state.usageStop ? (state.usageStop ?? 'STOP flag present (.factory/STOP)') : undefined;

  function DashboardPane(): JSX.Element {
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
          <RunDetail
            run={state.lanes[0].run}
            repo={repo}
            now={now}
            steeringQueued={steeringQueued[state.lanes[0].issue]}
          />
        </Box>
      );
    }

    return view === 'dashboard' ? (
      <Dashboard state={state} selectedIndex={clampedIndex} now={now} repo={repo} stopReason={stopReason} />
    ) : (
      <RunDetail
        run={state.lanes[clampedIndex].run}
        repo={repo}
        now={now}
        showBackHint
        steeringQueued={steeringQueued[state.lanes[clampedIndex].issue]}
      />
    );
  }

  const composerMissingPaths = composer?.warned
    ? extractPathCandidates(composer.text).filter((p) => composer.worktree && !pathExists(join(composer.worktree, p)))
    : [];

  return (
    <Box flexDirection="column">
      {composer ? (
        <SteeringComposer issue={composer.issue} draft={composer.text} missingPaths={composerMissingPaths} />
      ) : (
        visibleApprovals.length > 0 && (
          <ApprovalPrompt
            request={visibleApprovals[0]}
            pendingCount={visibleApprovals.length}
            denyReason={denyReason}
          />
        )
      )}
      <TabBar active={tab} />
      {tab === 'dashboard' && <DashboardPane />}
      {tab === 'queue' && <QueueTab snapshot={queueSnap} lanes={state.lanes} />}
      {tab === 'costs' && <CostsTab costs={costsRead} selectedIndex={costsSelected} />}
      {tab === 'log' && <LogTab events={events} scroll={logScroll} height={logHeight} />}
    </Box>
  );
}
