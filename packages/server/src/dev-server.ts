// packages/server/src/dev-server.ts — dev-only harness: starts GET /events on 127.0.0.1:8787 and
// emits synthetic lane lifecycle events so the dashboard status board (#593) can be exercised
// end to end. Never imported by product code; excluded from coverage.
import type { LaneLifecycleEvent } from '@on-par/contracts';

import { createServer } from './index.js';

const listeners = new Set<(event: LaneLifecycleEvent) => void>();
const bus = {
  on(listener: (event: LaneLifecycleEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

function emit(event: LaneLifecycleEvent): void {
  for (const listener of listeners) listener(event);
}

const server = createServer({ bus, port: 8787 });
const port = await server.start();
console.log(`factory-server dev harness listening on http://127.0.0.1:${port}/events`);

const PHASES = ['plan', 'build', 'check', 'ship'] as const;
const LANES = [
  { laneId: 'lane-101', issueId: '101', worktreePath: '/tmp/factory/issue-101' },
  { laneId: 'lane-102', issueId: '102', worktreePath: '/tmp/factory/issue-102' },
  { laneId: 'lane-103', issueId: '103', worktreePath: '/tmp/factory/issue-103' },
];

let step = 0;
const timer = setInterval(() => {
  const lane = LANES[step % LANES.length];
  const phaseIndex = Math.floor(step / LANES.length) % PHASES.length;
  const phase = PHASES[phaseIndex];
  const isFailingLane = lane.laneId === 'lane-103' && phase === 'check';
  const statuses = isFailingLane
    ? (['started', 'progress', 'failed'] as const)
    : (['started', 'progress', 'done'] as const);
  const status = statuses[step % statuses.length];

  emit({
    ts: new Date().toISOString(),
    laneId: lane.laneId,
    issueId: lane.issueId,
    phase,
    status,
    detail: `${phase} ${status}`,
    worktreePath: lane.worktreePath,
  });

  step += 1;
}, 1500);
timer.unref();

process.on('SIGINT', () => {
  clearInterval(timer);
  void server.stop().then(() => process.exit(0));
});
