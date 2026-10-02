// Intake approval trust (#1825, ADR-0128). One owner for "is this login a trusted approver?".
// An explicit trustedApprovers list is authoritative (even empty). Unset falls back to repo
// admins via the collaborator-permission API. Any lookup failure is untrusted (fail closed).
import type { Octokit } from '@octokit/rest';

/** Narrow port over GitHub's collaborator-permission endpoint. */
export interface CollaboratorPermissionClient {
  getPermissionLevel(input: { owner: string; repo: string; username: string }): Promise<string>;
}

export interface TrustedApproverOptions {
  owner: string;
  repo: string;
  /** `intake.trustedApprovers`. Undefined → admin fallback; any array (even []) is authoritative. */
  trustedApprovers?: readonly string[];
  client: CollaboratorPermissionClient;
}

export async function isTrustedApprover(login: string, options: TrustedApproverOptions): Promise<boolean> {
  const name = login.trim();
  if (name === '') return false;
  const { trustedApprovers, client, owner, repo } = options;
  if (trustedApprovers !== undefined) {
    const wanted = name.toLowerCase();
    return trustedApprovers.some((a) => a.trim().toLowerCase() === wanted);
  }
  try {
    return (await client.getPermissionLevel({ owner, repo, username: name })) === 'admin';
  } catch {
    return false;
  }
}

export function createOctokitCollaboratorPermissionClient(octokit: Octokit): CollaboratorPermissionClient {
  return {
    async getPermissionLevel({ owner, repo, username }) {
      const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
      return data.permission;
    },
  };
}
