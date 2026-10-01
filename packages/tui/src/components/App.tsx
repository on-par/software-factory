import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  type ApprovalRequest,
  type CostsRead,
  DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS,
  extractPathCandidates,
  type FactoryEvent,
  followEvents,
  listPendingApprovals,
  listQueuedSteering,
  phaseSnapshotFile,
  ProviderBreaker,
  type QueueSnapshot,
  queueSteeringMessage,
  readCostsFile,
  readPhaseSnapshot,
  redactSecretPatterns,
  respondToApproval,
  type RunPhaseSnapshot,
} from '@on-par/factory-core';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { type JSX, useEffect, useMemo, useState } from 'react';

import {
  type DashboardState,
  initialDashboard,
  isNonTerminalLane,
  lanesOf,
  legacyFailurePointerFor,
  partitionLanesByActivity,
  reduceDashboard,
} from '../dashboard.js';
import { CostsTab } from '../tabs/CostsTab.js';
import { resolveCostsSelection, summarizeRunCosts } from '../tabs/run-costs.js';
import { type BreakerRow, HealthTab } from '../tabs/HealthTab.js';
import type { HealthWindowName } from '../tabs/health-window.js';
import { initialLogScroll, reduceLogScroll } from '../tabs/log-scroll.js';
import { LogTab } from '../tabs/LogTab.js';
import { QueueTab } from '../tabs/QueueTab.js';
import { TabBar } from '../tabs/TabBar.js';
import { TAB_ORDER, type TabName } from '../tabs/types.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { Dashboard, staleLanesLine } from './Dashboard.js';
import { Header } from './Header.js';
import { summarizeLane } from './LaneList.js';
import { collapseMerged, LaneView } from './LaneView.js';
import { RunDetail } from './RunDetail.js';
import { SteeringComposer } from './SteeringComposer.js';
import { StopBanner } from './StopBanner.js';

const MAX_LOG_EVENTS = 5000;
const POLL_MS = 2000;

/** Where the Queue tab's backlog comes from. The CLI builds one (GitHub Issues by default, the
 *  local queue file under `--local-queue`) so this package never touches octokit itself (#1362). */
export interface QueueReader {
  /** Short source name shown in the Queue tab heading, e.g. "GitHub" or "local file". */
  source: string;
  /** One read. A thrown error is shown in the tab; the previous entries are kept. */
  read: () => Promise<QueueSnapshot> | QueueSnapshot;
  /** Poll interval; defaults to the TUI's file-poll cadence. GitHub-backed readers should pass a slower one. */
  pollMs?: number;
}

export interface AppProps {
  eventsFile: string;
  repo?: string;
  follow?: typeof followEvents;
  stopFile?: string;
  pathExists?: (p: string) => boolean;
  queueReader?: QueueReader;
  costsFile?: string;
  readCostsFn?: typeof readCostsFile;
  approvalsDir?: string;
  listPendingFn?: typeof listPendingApprovals;
  respondFn?: typeof respondToApproval;
  steeringDir?: string;
  queueSteeringFn?: typeof queueSteeringMessage;
  listSteeringFn?: typeof listQueuedSteering;
  breakerFile?: string;
  effectiveConfigLines?: string[];
  listBreakersFn?: (file: string) => Promise<BreakerRow[]>;
  /** `.factory/state/runs`: per-issue phase snapshots whose heartbeat keeps a quiet lane visible (#1369). */
  runsDir?: string;
  readSnapshotFn?: (file: string) => Promise<RunPhaseSnapshot | null>;
  staleThresholdMs?: number;
}

async function defaultListBreakersFn(file: string): Promise<BreakerRow[]> {
  const breakers = await new ProviderBreaker(file).list();
  return breakers.map((b) => ({ provider: b.provider, reason: b.reason, remainingMs: b.remainingMs }));
}

type View = 'lanes' | 'lane' | 'detail';

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
  queueReader,
  costsFile,
  readCostsFn = readCostsFile,
  approvalsDir,
  listPendingFn = listPendingApprovals,
  respondFn = respondToApproval,
  steeringDir,
  queueSteeringFn = queueSteeringMessage,
  listSteeringFn = listQueuedSteering,
  breakerFile,
  effectiveConfigLines,
  listBreakersFn = defaultListBreakersFn,
  runsDir,
  readSnapshotFn = readPhaseSnapshot,
  staleThresholdMs = DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS,
}: AppProps): JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<DashboardState>(initialDashboard());
  const [events, setEvents] = useState<FactoryEvent[]>([]);
  const [now, setNow] = useState(Date.now());
  const [laneIndex, setLaneIndex] = useState(0);
  const [issueIndex, setIssueIndex] = useState(0);
  const [mergedExpanded, setMergedExpanded] = useState(false);
  const [view, setView] = useState<View>('lanes');
  const [stopFlag, setStopFlag] = useState(false);
  const [tab, setTab] = useState<TabName>('dashboard');
  const [queueSnap, setQueueSnap] = useState<QueueSnapshot>({ entries: [] });
  const [costsRead, setCostsRead] = useState<CostsRead>({ entries: [], skipped: 0 });
  const [costsSelectedIssue, setCostsSelectedIssue] = useState<string | undefined>();
  const [costsExpanded, setCostsExpanded] = useState(false);
  const [logScroll, setLogScroll] = useState(initialLogScroll());
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [denyReason, setDenyReason] = useState<string | undefined>(undefined);
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [composer, setComposer] = useState<ComposerState | undefined>(undefined);
  const [steeringQueued, setSteeringQueued] = useState<Record<string, number>>({});
  const [breakers, setBreakers] = useState<BreakerRow[]>([]);
  const [healthSecondary, setHealthSecondary] = useState(false);
  const [healthWindow, setHealthWindow] = useState<HealthWindowName>('run');
  // null until the first snapshot poll resolves: replayed lanes must not flash as stale first.
  const [heartbeats, setHeartbeats] = useState<Record<string, string | undefined> | null>(null);

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
    if (!queueReader) return;
    let cancelled = false;
    let inFlight = false;
    const read = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const snapshot = await queueReader.read();
        if (!cancelled) setQueueSnap(snapshot);
      } catch (err) {
        // GitHub-controlled text: redact anything token-shaped before it reaches the pane.
        const message = redactSecretPatterns(err instanceof Error ? err.message : String(err));
        if (!cancelled) setQueueSnap((prev) => ({ ...prev, error: `queue lookup failed — ${message}` }));
      } finally {
        inFlight = false;
      }
    };
    void read();
    const interval = setInterval(() => void read(), queueReader.pollMs ?? POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [queueReader]);

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

  useEffect(() => {
    if (!breakerFile) return;
    const read = () => {
      void listBreakersFn(breakerFile).then(setBreakers);
    };
    read();
    const interval = setInterval(read, POLL_MS);
    return () => clearInterval(interval);
  }, [breakerFile, listBreakersFn]);

  const laneIssuesKey = state.lanes.map((l) => l.issue).join(',');

  useEffect(() => {
    if (!runsDir) return;
    let cancelled = false;
    let inFlight = false;
    const read = async () => {
      if (inFlight) return; // a slow read must not be overwritten by an older, later-landing one
      inFlight = true;
      try {
        const next: Record<string, string | undefined> = {};
        // Only non-terminal lanes can go stale, so only they need a heartbeat.
        await Promise.all(
          state.lanes.filter(isNonTerminalLane).map(async (lane) => {
            try {
              next[lane.issue] = (await readSnapshotFn(phaseSnapshotFile(runsDir, Number(lane.issue))))?.lastActivityAt;
            } catch {
              next[lane.issue] = undefined;
            }
          }),
        );
        if (!cancelled) setHeartbeats(next);
      } finally {
        inFlight = false;
      }
    };
    void read();
    const interval = setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // laneIssuesKey, not state.lanes: re-poll only when the set of issues changes.
  }, [runsDir, readSnapshotFn, laneIssuesKey]);

  const { active: activeLanes, staleCount } =
    runsDir && heartbeats === null
      ? { active: state.lanes, staleCount: 0 }
      : partitionLanesByActivity(state.lanes, { now, heartbeats: heartbeats ?? undefined, staleThresholdMs });
  const activeState: DashboardState = { ...state, lanes: activeLanes };

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

  const runCosts = useMemo(() => summarizeRunCosts(costsRead.entries, state.lanes), [costsRead, state.lanes]);
  const costsCurrent = resolveCostsSelection(runCosts, state.lanes, costsSelectedIssue);
  const logHeight = Math.max(5, (stdout?.rows ?? 24) - 4);
  const visibleApprovals = pendingApprovals.filter((r) => !answered.has(r.id));
  const groups = lanesOf(activeState);
  const clampedLane = Math.min(laneIndex, Math.max(0, groups.length - 1));
  const group = groups[clampedLane];
  const laneRows = group ? collapseMerged(group.issues, mergedExpanded).rows : [];
  const clampedIssue = Math.min(issueIndex, Math.max(0, laneRows.length - 1));
  const singleLane = groups.length === 1;
  const effectiveView: View = singleLane && view === 'lanes' ? 'lane' : view;

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
        // oxlint-disable-next-line no-control-regex -- stripping bracketed-paste markers
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
      activeLanes.length > 0 &&
      visibleApprovals.length === 0
    ) {
      const activeLane =
        activeLanes.length === 1
          ? activeLanes[0]
          : effectiveView === 'lanes'
            ? summarizeLane(group, now).current
            : laneRows[clampedIssue];
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
      setView('lanes');
      setMergedExpanded(false);
      return;
    }
    const digit = Number(input);
    if (Number.isInteger(digit) && digit >= 1 && digit <= TAB_ORDER.length) {
      setTab(TAB_ORDER[digit - 1]);
      setView('lanes');
      setMergedExpanded(false);
      return;
    }

    if (tab === 'dashboard') {
      if (effectiveView === 'lanes') {
        if (key.upArrow) setLaneIndex(Math.max(0, clampedLane - 1));
        if (key.downArrow) setLaneIndex(Math.min(groups.length - 1, clampedLane + 1));
        if (key.return && group) {
          setIssueIndex(0);
          setMergedExpanded(false);
          setView('lane');
        }
      } else if (effectiveView === 'lane') {
        if (key.upArrow) setIssueIndex(Math.max(0, clampedIssue - 1));
        if (key.downArrow) setIssueIndex(Math.min(laneRows.length - 1, clampedIssue + 1));
        if (input === 'm') {
          setMergedExpanded((e) => !e);
          setIssueIndex(0);
        }
        if (key.return && laneRows.length > 0) {
          setView('detail');
        }
        if (key.escape && !singleLane) {
          setView('lanes');
          setMergedExpanded(false);
        }
      } else if (key.escape) {
        setView('lane');
      }
    } else if (tab === 'costs') {
      const at = runCosts.issues.findIndex((i) => i.issue === costsCurrent);
      if (key.upArrow && at > 0) setCostsSelectedIssue(runCosts.issues[at - 1].issue);
      if (key.downArrow && at >= 0 && at < runCosts.issues.length - 1)
        setCostsSelectedIssue(runCosts.issues[at + 1].issue);
      if (key.return) setCostsExpanded((e) => !e);
      if (key.escape) setCostsExpanded(false);
    } else if (tab === 'log') {
      if (key.upArrow) setLogScroll((s) => reduceLogScroll(s, 'up', logHeight, events.length));
      if (key.downArrow) setLogScroll((s) => reduceLogScroll(s, 'down', logHeight, events.length));
      if (key.pageUp) setLogScroll((s) => reduceLogScroll(s, 'pageUp', logHeight, events.length));
      if (key.pageDown) setLogScroll((s) => reduceLogScroll(s, 'pageDown', logHeight, events.length));
      if (input === 'f') setLogScroll((s) => reduceLogScroll(s, 'toggleFollow', logHeight, events.length));
    } else if (tab === 'health') {
      if (input === 'e') setHealthSecondary((v) => !v);
      if (input === 'w') setHealthWindow((w) => (w === 'run' ? '24h' : 'run'));
    }
  });

  const stopReason = stopFlag || state.usageStop ? (state.usageStop ?? 'STOP flag present (.factory/STOP)') : undefined;

  function DashboardPane(): JSX.Element {
    if (activeLanes.length === 0) {
      return (
        <Box flexDirection="column">
          <Header repo={repo} done={false} />
          <Text dimColor>(idle — no active claims)</Text>
          {staleCount > 0 && <Text dimColor>{staleLanesLine(staleCount)}</Text>}
        </Box>
      );
    }

    if (activeLanes.length === 1) {
      return (
        <Box flexDirection="column">
          {stopReason && <StopBanner reason={stopReason} />}
          <RunDetail
            run={activeLanes[0].run}
            repo={repo}
            now={now}
            steeringQueued={steeringQueued[activeLanes[0].issue]}
            failureEvidence={activeLanes[0].failureEvidence}
            legacyFailurePointer={legacyFailurePointerFor(activeLanes[0])}
          />
          {staleCount > 0 && <Text dimColor>{staleLanesLine(staleCount)}</Text>}
        </Box>
      );
    }

    const detailRow = effectiveView === 'detail' ? laneRows[clampedIssue] : undefined;
    if (effectiveView === 'lanes') {
      return (
        <Dashboard
          state={activeState}
          selectedIndex={clampedLane}
          now={now}
          repo={repo}
          stopReason={stopReason}
          staleCount={staleCount}
        />
      );
    }
    if (detailRow) {
      return (
        <RunDetail
          run={detailRow.run}
          repo={repo}
          now={now}
          showBackHint
          steeringQueued={steeringQueued[detailRow.issue]}
          failureEvidence={detailRow.failureEvidence}
          legacyFailurePointer={legacyFailurePointerFor(detailRow)}
        />
      );
    }
    return (
      <LaneView
        group={group}
        state={activeState}
        selectedIndex={clampedIssue}
        mergedExpanded={mergedExpanded}
        now={now}
        canGoBack={!singleLane}
        stopReason={stopReason}
        staleCount={staleCount}
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
      {tab === 'queue' && <QueueTab snapshot={queueSnap} lanes={activeLanes} source={queueReader?.source} />}
      {tab === 'costs' && (
        <CostsTab
          costs={costsRead}
          lanes={state.lanes}
          selectedIssue={costsCurrent}
          expanded={costsExpanded}
          width={stdout?.columns ?? 100}
        />
      )}
      {tab === 'log' && <LogTab events={events} scroll={logScroll} height={logHeight} />}
      {tab === 'health' && (
        <HealthTab
          events={events}
          costs={costsRead.entries}
          breakers={breakers}
          effectiveConfigLines={effectiveConfigLines ?? []}
          showSecondary={healthSecondary}
          window={healthWindow}
          runStartedAt={runCosts.runStartedAt}
          now={now}
        />
      )}
    </Box>
  );
}
