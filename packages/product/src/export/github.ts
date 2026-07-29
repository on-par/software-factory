// packages/product/src/export/github.ts — file the plan on a target repo via a port (#476).

import type { ExportPlan } from './plan.js';
import { renderEpicIssue, renderStoryIssue } from './issues.js';

export interface ExportTarget {
  owner: string;
  repo: string;
}

/** The GitHub seam — shaped after core's FilingGitHubClient; the caller injects a real impl. */
export interface ExportGitHubClient {
  createIssue(input: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels: readonly string[];
  }): Promise<{ number: number; url?: string }>;
  commentIssue(input: { owner: string; repo: string; issue_number: number; body: string }): Promise<void>;
}

export interface ExportedIssue {
  kind: 'epic' | 'story';
  title: string;
  number: number;
  url?: string;
}

export interface GitHubExportResult {
  epic: ExportedIssue;
  stories: readonly ExportedIssue[];
  bundleComments: number;
}

/** Files the epic, then each story in build order, then attaches the bundle as comments on the epic. */
export async function exportToGitHub(
  plan: ExportPlan,
  target: ExportTarget,
  client: ExportGitHubClient,
): Promise<GitHubExportResult> {
  const { owner, repo } = target;

  const epicPayload = renderEpicIssue(plan.epic);
  const createdEpic = await client.createIssue({ owner, repo, ...epicPayload });
  const epic: ExportedIssue = {
    kind: 'epic',
    title: plan.epic.title,
    number: createdEpic.number,
    url: createdEpic.url,
  };

  const stories: ExportedIssue[] = [];
  for (const story of plan.stories) {
    const payload = renderStoryIssue(story, epic.number);
    const created = await client.createIssue({ owner, repo, ...payload });
    stories.push({ kind: 'story', title: story.title, number: created.number, url: created.url });
  }

  for (const file of plan.bundle.files) {
    await client.commentIssue({
      owner,
      repo,
      issue_number: epic.number,
      body: `## Design Bundle — ${file.path}\n\n${file.content}`,
    });
  }

  return { epic, stories, bundleComments: plan.bundle.files.length };
}
