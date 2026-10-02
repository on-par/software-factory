// `factory approve <n> --rewrite` logic (#1843): draft a factory-task spec with a tool-less agent,
// show it, and on confirm replace the issue body and report the approval hash of the new content.
import { computeApprovalHash } from '@on-par/factory-core/internal';
import type { TriageRewriteResult } from '@on-par/factory-core/internal';

export interface ApproveRewriteDeps {
  issue: number;
  yes?: boolean;
  getIssue: (n: number) => Promise<{ title: string; body: string }>;
  updateIssueBody: (n: number, body: string) => Promise<void>;
  rewrite: (input: { title: string; body: string }) => Promise<TriageRewriteResult>;
  /** TTY prompt; returns false when not a TTY. */
  confirm: (question: string) => Promise<boolean>;
  out: (line: string) => void;
}

const normalizeEol = (s: string): string => s.replace(/\r\n?/g, '\n');

export async function runApproveRewrite(
  deps: ApproveRewriteDeps,
): Promise<{ applied: boolean; approvalHash: string | null }> {
  const { issue } = deps;
  const filed = await deps.getIssue(issue);
  const result = await deps.rewrite({ title: filed.title, body: filed.body });
  if (!result.ok) throw new Error(`triage rewrite refused: ${result.reason}`);

  deps.out(`--- draft for #${issue} ---`);
  deps.out(result.draft);
  deps.out('--- end draft ---');

  const confirmed = deps.yes === true || (await deps.confirm('Replace the issue body with this draft? [y/N] '));
  if (!confirmed) {
    deps.out('not applied');
    return { applied: false, approvalHash: null };
  }

  await deps.updateIssueBody(issue, result.body);
  const after = await deps.getIssue(issue);
  if (normalizeEol(after.body) !== normalizeEol(result.body)) {
    throw new Error('issue body changed during rewrite');
  }
  const approvalHash = computeApprovalHash({ title: after.title, body: after.body });
  deps.out(`approval hash: sha256:${approvalHash}`);
  return { applied: true, approvalHash };
}
