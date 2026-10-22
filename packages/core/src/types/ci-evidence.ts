// src/types/ci-evidence.ts — CI-failure evidence types carried on SHIP ci-failed park events (#2814), split from index.ts

/** One failing CI check run in CiFailureEvidence (#2814). */
export interface CiFailingCheck {
  name: string;
  conclusion: string;
  summary?: string;
}

/** One open code-scanning alert on the PR head (#2814). `location` is "path:line" (or "path" without a line). */
export interface CiCodeScanningAlert {
  ruleId: string;
  location: string;
  message: string;
}

/** One CI-failure item's attribution to the PR (#2817). */
export interface CiAttributionItem {
  kind: 'codeql-alert' | 'check';
  /** Alert: "ruleId at path:line"; check: the check name. */
  ref: string;
  attributable: boolean;
  /** e.g. 'file changed by this PR', 'also failing on base main@abc123def456', 'base checks unavailable'. */
  reason: string;
}

/** Attribution of a SHIP CI failure (#2817). baseline = no item is attributable to the PR. */
export interface CiAttribution {
  baseline: boolean;
  baseRef?: string;
  baseSha?: string;
  items: CiAttributionItem[];
}

/** Tail of one failing Actions job's log, fed to non-CodeQL CI rework (#3537). */
export interface CiJobLogExcerpt {
  name: string;
  jobId: number;
  excerpt: string;
  truncated: boolean;
}

/** One suppression-guard hit in a SHIP CI rework diff (#2818). */
export interface CiSuppressionFinding {
  kind: 'comment' | 'path' | 'ratchet';
  /** e.g. 'codeql-comment', 'lgtm-comment', 'nosec-comment', 'eslint-disable-security', 'workflow-path', 'codeql-path', 'sarif-path', 'guard-error', 'max-lines-ceiling', 'coverage-threshold'. */
  rule: string;
  /** Repo-relative path, '(unknown)' when the diff had no file header. */
  file: string;
  /** New-file line number for comment hits, when the hunk header gave one. */
  line?: number;
  /** The offending added line (trimmed, max 200 chars) or the touched path. */
  match: string;
}

/** Bounded CI-failure evidence carried on a SHIP ci-failed park event (#2814). */
export interface CiFailureEvidence {
  failingChecks: CiFailingCheck[];
  alerts: CiCodeScanningAlert[];
  /** True when checks/alerts were dropped past the caps or a text field was cut. */
  truncated: boolean;
  /** Best-effort collection errors ("checks: …", "code-scanning: …"); omitted when none. */
  errors?: string[];
  /** Which failing items the PR caused versus baseline failures (#2817). */
  attribution?: CiAttribution;
  /** Suppression-guard hits that parked a CI rework round (#2818). */
  suppressionAttempt?: CiSuppressionFinding[];
  /** Log tails of the failing jobs fed to a non-CodeQL CI rework round (#3537). */
  jobLogs?: CiJobLogExcerpt[];
}
