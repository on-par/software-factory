import type { Octokit } from '@octokit/rest';

import type { PreviewGitHub } from './preview-source.js';

export function createOctokitPreviewGitHub(octokit: Octokit): PreviewGitHub {
  return {
    async listDeployments({ owner, repo, headSha }) {
      const data = await octokit.paginate(octokit.rest.repos.listDeployments, {
        owner,
        repo,
        sha: headSha,
        per_page: 100,
      });
      return data.map((d) => ({ id: d.id, environment: d.environment, createdAt: d.created_at }));
    },
    async listDeploymentStatuses({ owner, repo }, deploymentId) {
      const { data } = await octokit.rest.repos.listDeploymentStatuses({
        owner,
        repo,
        deployment_id: deploymentId,
        per_page: 100,
      });
      return data.map((s) => ({
        state: s.state,
        createdAt: s.created_at,
        environmentUrl: s.environment_url,
        targetUrl: s.target_url,
      }));
    },
    async listComments({ owner, repo, prNumber }) {
      const data = await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
      });
      return data.map((c) => ({
        body: c.body ?? '',
        author: c.user?.login ?? '',
        authorAssociation: c.author_association,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      }));
    },
    async headCommitDate({ owner, repo, headSha }) {
      const { data } = await octokit.rest.repos.getCommit({ owner, repo, ref: headSha });
      return data.commit.committer?.date;
    },
  };
}
