// packages/core/src/phases/ship-open-pr.ts — SHIP draft PR creation and already-exists recovery

import { briefSummaryLine, renderPrBody, stripBriefIds } from '../reports/pr-body.js';
import type { WorkRequest } from '../work/index.js';
import { issueNumberOf } from '../work/work-key.js';
import { SHIP_BASE_BRANCH, type ShipPhaseOptions } from './ship-options.js';
import { findOpenPR, isPullAlreadyExistsError } from './ship-pr-lookup.js';
import { readRisk, readSpecBody } from './ship-spec.js';
import type { ShipResult } from './ship-types.js';
import type { lazyWalkthrough } from './ship-walkthrough.js';
import { prerequisiteStackOrder, renderStackOrderLine, type StackPosition } from './stack-order.js';

export async function openOrFindPr(ctx: {
  opts: ShipPhaseOptions;
  inlineWork: Pick<WorkRequest, 'id' | 'kind' | 'title' | 'reference'> | undefined;
  stack: StackPosition | undefined;
  base: string;
  owner: string;
  repoName: string;
  walkthrough: ReturnType<typeof lazyWalkthrough>;
}): Promise<{ stop: ShipResult } | { prNumber: number }> {
  const { opts, inlineWork, stack, base, owner, repoName, walkthrough } = ctx;
  const { octokit, issue, branch, checkSummary, log } = opts;
  let prNumber: number;
  // Get title from issue (skipped for a non-github work source — no such issue exists)
  const title = inlineWork
    ? inlineWork.title
    : (await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issueNumberOf(issue) })).data.title;

  const slice = inlineWork ? undefined : opts.slice;
  const finalSlice = !slice || slice.index >= slice.count;
  // A brief is a local file reviewers cannot open, so the body describes it by its title and links the
  // open PR it builds on (a --stack or --base-branch base), never its id, digest or path.
  const basePr = inlineWork && base !== SHIP_BASE_BRANCH ? await findOpenPR(octokit, owner, repoName, base) : undefined;
  const summaryLine = inlineWork
    ? briefSummaryLine(title, basePr?.status === 'found' ? basePr.prNumber : undefined)
    : slice
      ? `Implements slice ${slice.index}/${slice.count} of #${issue}.`
      : `Implements #${issue}.`;
  const prTitle = inlineWork
    ? stripBriefIds(title)
    : slice
      ? `${title} — slice ${slice.index}/${slice.count} (#${issue})`
      : `${title} (#${issue})`;

  // Create PR
  try {
    const { data: pr } = await octokit.rest.pulls.create({
      owner,
      repo: repoName,
      head: branch,
      base,
      title: prTitle,
      draft: true,
      body: renderPrBody({
        summaryLine,
        footer: opts.footer,
        stackOrder: stack ? renderStackOrderLine(stack) : prerequisiteStackOrder(opts.prerequisiteStack, issue, base),
        specBody: await readSpecBody(opts.specPath),
        checkSummary,
        reworkRounds: opts.reworkRounds,
        risk: await readRisk(opts.specPath),
        walkthrough: await walkthrough.walkthrough(),
        typescriptLines: await walkthrough.counts(),
        closes: inlineWork || !finalSlice ? undefined : issue,
        partOf: !inlineWork && !finalSlice ? issue : undefined,
      }),
    });

    prNumber = pr.number;
    log('pr_opened', `opened PR #${prNumber} for committed work on ${branch} (base ${base})`);
  } catch (err) {
    if (!isPullAlreadyExistsError(err)) throw err;
    const existing = await findOpenPR(octokit, owner, repoName, branch);
    if (existing.status !== 'found') {
      const reason = `pulls.create reported an existing PR for ${branch} but re-querying did not find it (${existing.status === 'error' ? existing.detail : 'no open PR listed'})`;
      log('ship', `${reason} — aborting`);
      return { stop: { ok: false, reason } };
    }
    prNumber = existing.prNumber;
    log('recovered', `PR #${prNumber} already existed for ${branch}; reusing it`);
  }
  return { prNumber };
}
