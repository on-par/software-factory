import { describe, expect, it, vi } from 'vitest';

import {
  computeApprovalHash,
  ORIGINAL_EVIDENCE_SUMMARY,
  renderRewrittenIssueBody,
  TRIAGE_REWRITE_SECTIONS,
} from '@on-par/factory-core/internal';
import type { TriageRewriteResult } from '@on-par/factory-core/internal';

import { runApproveRewrite } from './approve-rewrite.js';

const FILED = 'raw evidence <!-- fp:abc -->';
const DRAFT = TRIAGE_REWRITE_SECTIONS.map((s) => `## ${s}\nx`).join('\n\n');

function setup(opts: { rewrite?: TriageRewriteResult; confirm?: boolean; drift?: boolean } = {}) {
  const store = { title: 'Bug', body: FILED };
  const updateIssueBody = vi.fn(async (_n: number, body: string) => {
    store.body = opts.drift ? `${body}\nedited` : body;
  });
  const rewrite = vi.fn(
    async () =>
      opts.rewrite ?? { ok: true as const, model: 'm', draft: DRAFT, body: renderRewrittenIssueBody(DRAFT, FILED) },
  );
  const out: string[] = [];
  const deps = {
    issue: 7,
    getIssue: async () => ({ ...store }),
    updateIssueBody,
    rewrite,
    confirm: vi.fn(async () => opts.confirm ?? false),
    out: (l: string) => out.push(l),
  };
  return { store, deps, updateIssueBody, out };
}

describe('runApproveRewrite', () => {
  it('applies the draft with --yes and returns the hash of the stored body', async () => {
    const { store, deps, out } = setup();
    const res = await runApproveRewrite({ ...deps, yes: true });
    expect(res.applied).toBe(true);
    expect(res.approvalHash).toBe(computeApprovalHash({ title: 'Bug', body: store.body }));
    for (const s of TRIAGE_REWRITE_SECTIONS) expect(store.body).toContain(`## ${s}`);
    expect(store.body).toContain(`<summary>${ORIGINAL_EVIDENCE_SUMMARY}</summary>`);
    expect(store.body).toContain(`\`\`\`\`\`\n${FILED}\n\`\`\`\`\``);
    expect(out).toContain(`approval hash: sha256:${res.approvalHash}`);
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it('applies on interactive confirmation', async () => {
    const { deps } = setup({ confirm: true });
    expect((await runApproveRewrite(deps)).applied).toBe(true);
  });

  it('changes nothing when not confirmed', async () => {
    const { deps, updateIssueBody, out } = setup({ confirm: false });
    expect(await runApproveRewrite(deps)).toEqual({ applied: false, approvalHash: null });
    expect(updateIssueBody).not.toHaveBeenCalled();
    expect(out).toContain('not applied');
  });

  it('throws without updating when the rewrite fails', async () => {
    const { deps, updateIssueBody } = setup({ rewrite: { ok: false, reason: 'draft missing: Files' } });
    await expect(runApproveRewrite({ ...deps, yes: true })).rejects.toThrow('draft missing: Files');
    expect(updateIssueBody).not.toHaveBeenCalled();
  });

  it('throws when the read-back body differs', async () => {
    const { deps } = setup({ drift: true });
    await expect(runApproveRewrite({ ...deps, yes: true })).rejects.toThrow('issue body changed');
  });
});
