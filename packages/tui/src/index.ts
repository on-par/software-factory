export { runTui } from './run-tui.js';
export type { RunTuiOptions } from './run-tui.js';
export { followPlain } from './fallback.js';
export { PHASES, initialState, reduceEvent, isFailoverEvent } from './state.js';
export type { PhaseName, PhaseStatus, RunState } from './state.js';
export {
  initialDashboard,
  isLaneEvent,
  reduceDashboard,
  mergeTrainPosition,
  laneElapsedMs,
} from './dashboard.js';
export type { LaneStatus, LaneState, DashboardState } from './dashboard.js';
export { Header } from './components/Header.js';
export type { HeaderProps } from './components/Header.js';
export { PhaseRow, spinnerFrame, formatElapsed, formatDuration } from './components/PhaseRow.js';
export type { PhaseRowProps } from './components/PhaseRow.js';
export { EventFeed } from './components/EventFeed.js';
export type { EventFeedProps } from './components/EventFeed.js';
export { RunDetail } from './components/RunDetail.js';
export type { RunDetailProps } from './components/RunDetail.js';
export { LaneRow } from './components/LaneRow.js';
export type { LaneRowProps } from './components/LaneRow.js';
export { StopBanner } from './components/StopBanner.js';
export type { StopBannerProps } from './components/StopBanner.js';
export { Dashboard } from './components/Dashboard.js';
export type { DashboardProps } from './components/Dashboard.js';
export { App } from './components/App.js';
export type { AppProps } from './components/App.js';
