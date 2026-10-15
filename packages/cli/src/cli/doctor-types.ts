// Leaf module: shared doctor row types and constants, imported by doctor.ts and its helpers.

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** One-line fix suggestion; only meaningful when ok=false. */
  fix?: string;
  /** Optional checks never fail the doctor exit code. */
  optional?: boolean;
  /** Setup section the row renders under (#2555); unsectioned rows render first. */
  section?: string;
  /** Exactly one shell command to run next (#2557); rendered as the last line of a non-ok row. */
  next?: string;
}

export interface DoctorExecOptions {
  /** Extra env vars merged over process.env for this command. */
  env?: Record<string, string>;
  /** Kill the command after this many ms; the probe then returns null. */
  timeoutMs?: number;
}

export const NOT_IN_REPO_HINT = 'cd into your repo, then run factory doctor again';

/** Detail for every repo wired-up row when doctor runs outside a git repository (#2554). */
export const NOT_IN_REPO_SKIP_DETAIL = `skipped: not inside a git repository; ${NOT_IN_REPO_HINT}`;
