// packages/product/src/export/render.ts — human-readable export summary (#476).

import type { ExportedIssue, GitHubExportResult } from './github.js';

function issueLabel(issue: ExportedIssue): string {
  return issue.url !== undefined ? `#${issue.number} ${issue.title} (${issue.url})` : `#${issue.number} ${issue.title}`;
}

/** Human-readable markdown lines for the CLI. Matches renderReadinessReport's plain-ASCII style. */
export function renderExportResult(result: GitHubExportResult): string[] {
  const lines: string[] = ['# Export', `Epic: ${issueLabel(result.epic)}`];

  for (const story of result.stories) {
    lines.push(`- Story: ${issueLabel(story)}`);
  }

  lines.push(`Bundle: ${result.bundleComments} file(s) attached to the epic issue.`);

  return lines;
}
