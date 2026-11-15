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
import type { PublishedVisualProofMode } from '../checkers/visual-proof-attach.js';
import type { VisualProofGate } from './ship-visual-proof.js';
import type { WalkthroughShipOpts } from './ship-walkthrough.js';
import type { PrerequisiteStackTarget } from '../queue/prerequisite-stack.js';
import type { StackPosition } from './stack-order.js';

export const SHIP_BASE_BRANCH = 'main';

export interface ShipPhaseOptions {
  issue: WorkKey;
  repo: string;
  worktree: string;
  branch: string;
  octokit: Octokit;
  watchCI?: boolean;
  syncMain?: boolean;
  footer?: string;
  draft?: boolean;
  evidenceComment?: boolean;
  log: (type: EventKind, msg: string) => void;
  run?: CommandRunner;
  rerun?: (argv: readonly string[]) => Promise<{ ok: boolean }>;
  approvalGate?: ApprovalGate;
  checkSummary?: CheckSummary;
  specPath?: string;
  eventsFile?: string;
  startedAt?: string;
  logsDir?: string;
  reworkRounds?: number;
  reviewRouting?: ReviewRouting;
  pinNotes?: string[];
  work?: Pick<WorkRequest, 'id' | 'kind' | 'title' | 'reference'>;
  slice?: { index: number; count: number };
  stack?: StackPosition;
  baseBranch?: string;
  prerequisiteStack?: PrerequisiteStackTarget;
  laneId?: string;
  bus?: LifecycleBus;
  recordedRemoteSha?: string;
  reentry?: { prNumber: number; previousHeadSha?: string };
  ciDeadlineMs?: number;
  walkthrough?: WalkthroughShipOpts['walkthrough'];
  previewGate?: PreviewGate;
  visualProofGate?: VisualProofGate;
  visualProofMode?: PublishedVisualProofMode;
  ciWatch?: typeof watchChecksWithInfraRerun;
}
