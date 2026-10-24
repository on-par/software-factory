// src/run/park-steward.ts — hand a stuck parked run to the steward, split out of run-issue.ts

import { issueNumberOf } from '../work/work-key.js';
import { detectStuck } from '../steward/detect.js';
import { runSteward } from '../steward/run.js';
import type { RunOutcome } from './outcome.js';
import type { RunPorts, RunRequest } from './run-issue.js';

/** The steward runs after the park event and before the reports and the return, so it finishes
 *  before the CLI raises LaneParkError or pauses the lane (#2124). */
export async function runParkSteward(
  outcome: RunOutcome,
  request: RunRequest,
  runId: string,
  ports: RunPorts,
  log: ReturnType<RunPorts['events']>,
): Promise<void> {
  if (request.stewardEnabled !== true) return;
  const stuck = detectStuck(outcome);
  if (!stuck) return;
  log(
    'steward-triggered',
    `stuck run picked up for the steward: ${stuck.trigger}${stuck.failureSignature ? ` (signature ${stuck.failureSignature})` : ''}`,
    { stewardTriggered: stuck },
  );
  if (ports.steward) {
    await runSteward(
      {
        runId,
        repo: request.repo,
        issue: { number: issueNumberOf(request.issue), title: request.work.title, body: request.work.brief },
        stuck,
        planPath: request.specPath,
      },
      ports.steward,
    );
  }
}
