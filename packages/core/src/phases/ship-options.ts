// packages/core/src/phases/ship-options.ts — SHIP phase options and the base branch it ships against

import type { Octokit } from '@octokit/rest';

import type { ApprovalGate } from '../approvals/index.js';
import type { LifecycleBus } from '../bus/index.js';
import type { EventKind } from '../events/kinds.js';
import type { ReviewRouting } from '../review/routing.js';
import type { CheckSummary } from '../types/index.js';
import type { watchChecksWithInfraRerun } from '../utils/ci-watch.js';
import type { WorkRequest } from '../work/index.js';
import type { WorkKey } from '../work/work-key.js';
import type { CommandRunner } from './ship-git.js';
import type { PreviewGate } from './ship-preview.js';
import type { WalkthroughShipOpts } from './ship-walkthrough.js';
import type { StackPosition } from './stack-order.js';

/** Ship opens PRs against, and watches required checks of, this branch. */
export const SHIP_BASE_BRANCH = 'main';

export interface ShipPhaseOptions {
  issue: WorkKey;
  repo: string;
  worktree: string;
  branch: string;
  octokit: Octokit;
  watchCI?: boolean;
  /** Resolved pr.footer; undefined uses the default, empty string omits it. */
  footer?: string;
  /** Stop at the draft PR: skip mark-ready (#3449). */
  draft?: boolean;
  /** Post the evidence pack as a PR comment (pr.evidenceComment); default off. */
  evidenceComment?: boolean;
  log: (type: EventKind, msg: string) => void;
  run?: CommandRunner;
  /** Runs the gh rerun argv for the CI infra rescue (#2365); default runCommand. */
  rerun?: (argv: readonly string[]) => Promise<{ ok: boolean }>;
  approvalGate?: ApprovalGate;
  checkSummary?: CheckSummary;
  specPath?: string;
  eventsFile?: string;
  startedAt?: string;
  logsDir?: string;
  reworkRounds?: number;
  /** PR classifier decision (#1724), rendered into the evidence pack. */
  reviewRouting?: ReviewRouting;
  /** Model pins that were not honored (#2511), rendered into the evidence pack. */
  pinNotes?: string[];
  /** The run's resolved work request; when its kind is not 'github-issue', the PR
   *  title/body come from it instead of fetching the (nonexistent) issue (#507). */
  work?: Pick<WorkRequest, 'id' | 'kind' | 'title' | 'reference'>;
  /** The ADR-0147 slice this run ships; titles the PR `slice k/n` and only the final slice closes the issue. */
  slice?: { index: number; count: number };
  /** Stack-mode (ADR-0161) position: the PR opens on `stack.base` and its body names the stack order. Ignored for inline work. */
  stack?: StackPosition;
  /** PR base for a non-stack run started from another branch (#3764); default main. */
  baseBranch?: string;
  /** Lane id stamped onto emitted lifecycle events; defaults to `issue-<issue>` (#591). */
  laneId?: string;
  /** Lifecycle bus to emit onto; defaults to the process-wide `lifecycleBus` (#591). */
  bus?: LifecycleBus;
  /** origin/<branch> SHA recorded at worktree creation (#1868). When set, the new-PR push
   *  replaces that stale head under a lease on this SHA, and fails closed if the remote moved (#1869). */
  recordedRemoteSha?: string;
  /** SHIP re-entry after a CI rework round (#2816): same open PR, plain push, watch the pushed SHA. */
  reentry?: { prNumber: number; previousHeadSha?: string };
  /** CI watch deadline (#3569); default DEFAULT_CI_DEADLINE_MS. */
  ciDeadlineMs?: number;
  walkthrough?: WalkthroughShipOpts['walkthrough'];
  previewGate?: PreviewGate;
  ciWatch?: typeof watchChecksWithInfraRerun;
}
