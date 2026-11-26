import type { PreviewCheckResult } from '../checkers/preview-check.js';
import type { VisualProofResult } from '../checkers/visual-proof.js';
import type { CiFailureEvidence } from '../types/index.js';
import type { InfraRerunOutcome } from '../utils/ci-watch.js';

export type ShipDraftReason = 'ci-pending' | 'requested';

export interface ShipResult {
  ok: boolean;
  prNumber?: number;
  denied?: boolean;
  deniedReason?: string;
  reason?: string;
  ciOutcome?: InfraRerunOutcome;
  ciFailure?: CiFailureEvidence;
  alreadyDelivered?: boolean;
  headSha?: string;
  noNewCommit?: boolean;
  draft?: boolean;
  ciPending?: boolean;
  draftReason?: ShipDraftReason;
  previewCheck?: PreviewCheckResult;
  visualProof?: VisualProofResult;
}

export type PrLookup =
  { status: 'found'; prNumber: number } | { status: 'absent' } | { status: 'error'; detail: string };
