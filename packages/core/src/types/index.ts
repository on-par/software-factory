// src/types/index.ts — Core type definitions for the Software Factory

// ---------- Models ----------

export type ModelProvider = 'anthropic' | 'openai' | 'ollama' | 'deepseek' | 'custom' | (string & {});
export type ModelTier = string; // 'boss' | 'worker' | 'checker' | 'triage' | '*_fallback' — kept as string for extensibility
export type ModelCapability = string; // kept as string for extensibility

export interface ModelDefinition {
  provider: ModelProvider;
  tier: ModelTier | ModelTier[];
  costPerMtokInput: number;
  costPerMtokOutput: number;
  contextWindow: number;
  capabilities: ModelCapability[];
  envKey: string | null;
  /** Flag to pass to `claude -p --model <flag>` */
  claudeFlag?: string;
  /** Provider-native model id, e.g. the Ollama tag to pass to /api/chat */
  providerModel?: string;
  /** Provider-native options, e.g. Ollama num_ctx/temperature */
  providerOptions?: Record<string, unknown>;
  /** Whether this model runs via Codex CLI */
  codex?: boolean;
  /** Extra Codex CLI flags */
  codexFlag?: string;
  /** Coding-harness id this model dispatches through (see harness/catalog.ts).
   *  When absent, inferred from provider/codex flags for back-compat. */
  harness?: string;
  /** Speculative/unproven model — excluded from routing unless FACTORY_EXPERIMENTAL=1 */
  experimental?: boolean;
}

// ---------- Config types (re-exported from config module) ----------
// See config/index.ts for the Zod-validated type definitions.
// These are re-exported here for convenience.

// ---------- Routes ----------

export type TaskType =
  | 'plan'
  | 'build_codex'
  | 'build_claude'
  | 'check_compile'
  | 'check_tests'
  | 'check_lint'
  | 'check_accessibility'
  | 'check_links'
  | 'check_custom'
  | 'review_pr'
  | 'security_review'
  | 'dispute_resolution'
  | 'triage'
  | (string & {}); // extensible

export interface RouteDefinition {
  tier: string;
  description: string;
  requires?: string;
}

// ---------- Factory Config ----------
// FactoryConfig is also defined via Zod in config/index.ts.

// ---------- Constitutions ----------

export interface Constitution {
  product: string;
  version: number;
  checkers: string[];
  /** When true, a worktree with no verify/test command FAILs the tests checker instead of SKIPping (frontmatter: requireTests) */
  requireTests?: boolean;
  body: string;
  path: string;
  /** Where the standards came from: the target repo's own instruction files, or a bundled <product>.md */
  source: 'repo' | 'bundled';
}

// ---------- Checkers ----------

export type CheckResult = 'PASS' | 'FAIL' | 'SKIP';

export interface CheckerOutput {
  checker: string;
  result: CheckResult;
  details: string;
  linksChecked?: number;
  broken?: number;
}

export interface CheckSummary {
  failures: number;
  passes: number;
  skips: number;
  total: number;
  results: CheckerOutput[];
  /** Non-blocking environment findings (e.g. headed e2e configs) surfaced during CHECK. */
  warnings?: string[];
}

// ---------- Failover ----------

/** Why the router abandoned a model. Matches the harness failure classification
 *  (harness/index.ts aliases HarnessFailureReason to this type). */
export type FailoverReason =
  | 'rate_limit'
  | 'usage_cap'
  | 'timeout'
  | 'error'
  | 'empty_response'
  | 'unavailable'
  | 'schema_invalid'
  | 'apply_failed'
  | 'verify_failed'
  | 'unknown';

// ---------- Failure fingerprint & evidence (#372) ----------

/** Pipeline phase a failure terminated in. */
export type FailurePhase = 'plan' | 'build' | 'check' | 'ship';

/** Whether the fault is in the factory itself or in the product under work. */
export type FailureOrigin = 'factory-internal' | 'product';

/** Fields that identify a defect and compose its deterministic signature. */
export interface FailureSignatureInput {
  /** Raw error message / event excerpt (volatile tokens stripped at fingerprint time). */
  message: string;
  phase: FailurePhase;
  /** Harness id or checker name, e.g. 'codex-cli', 'check:tests'. */
  component: string;
  origin: FailureOrigin;
  /** Classified reason from classifyFailure (#368). */
  reason: FailoverReason;
}

/** Everything a downstream filing story needs without re-deriving from the log. */
export interface EvidencePack {
  repo: string;
  issue: string;
  phase: FailurePhase;
  model: string;
  reason: FailoverReason;
  component: string;
  origin: FailureOrigin;
  eventExcerpt: string;
  logPath: string;
}

/** Inputs to captureFailure: signature fields plus the evidence-only context. */
export interface CaptureFailureInput extends FailureSignatureInput {
  repo: string;
  issue: string;
  model: string;
  logPath: string;
  /** Excerpt char cap (default 600). */
  excerptLimit?: number;
}

export interface FingerprintedFailure {
  fingerprint: string;
  evidence: EvidencePack;
}

// ---------- Events ----------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Best-effort classification of why a rework round happened (#386). */
export type ReworkCause = 'factory-fault' | 'direction-change' | 'external';

/** Cause bucket for a retry attempt (#419): checker = rework round after failed
 *  checks, failover = provider/quota failover, timeout = runaway agent,
 *  other = unclassifiable. */
export type RetryCause = 'checker' | 'failover' | 'timeout' | 'other';

/** Explicit human-action event types (#420). Each event carries issue, actor, ts, msg.
 *  'human-restarted' is emitted live by the CLI; the other four are reconstructed
 *  from the GitHub API at report time by reconstructHumanEvents(). */
export type HumanEventType = 'human-approved' | 'human-edited' | 'human-restarted' | 'human-merged' | 'human-abandoned';

/** Structured payload carried on `rework`/`stuck` events for later metrics (#386). */
export interface ReworkInfo {
  /** 1-based rework round number. */
  round: number;
  /** Checker names that failed this round (e.g. ['tests','lint']). */
  failingChecks: string[];
  cause: ReworkCause;
  /** True when this round marks the lane stuck (identical failures repeated). */
  stuck?: boolean;
}

export interface FactoryEvent {
  ts: string;
  type: string;
  issue: string;
  msg: string;
  level?: LogLevel;
  lane?: string;
  phase?: string;
  /** Human who performed the action, for human-* event types (#420). */
  actor?: string;
  failoverReason?: FailoverReason;
  fingerprint?: string;
  evidence?: EvidencePack;
  rework?: ReworkInfo;
}

// ---------- Cost Tracking ----------

export interface CostEntry {
  ts: string;
  issue: string;
  task: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  failoverReason?: FailoverReason;
  /** Set when this row is the cost of a retry attempt (#419). */
  retryCause?: RetryCause;
}

// ---------- Dispute ----------

export type DisputeVerdict = 'upheld' | 'overruled';

export interface DisputeResult {
  verdict: DisputeVerdict;
  reasoning: string;
  action: string;
}

// ---------- Run State ----------

export type RunStatus =
  | 'pending'
  | 'planning'
  | 'building'
  | 'checking'
  | 'reworking'
  | 'shipping'
  | 'ready'
  | 'awaiting-review'
  | 'parked'
  | 'escalated'
  | 'merged'
  | 'failed';

export interface IssueRunState {
  issue: number;
  lane: string;
  status: RunStatus;
  branch: string;
  worktree: string;
  specPath: string;
  model: string;
  route: 'codex' | 'claude';
  attempts: number;
  startedAt: string;
  updatedAt: string;
  prNumber?: number;
  failures?: CheckerOutput[];
}
