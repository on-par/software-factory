import type { PreviewConfig } from '../config/preview-section.js';

export interface PreviewTarget {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

export interface PreviewDeployment {
  id: number;
  environment: string;
  createdAt: string;
}

export interface PreviewDeploymentStatus {
  state: string;
  createdAt: string;
  environmentUrl?: string;
  targetUrl?: string;
}

export interface PreviewComment {
  body: string;
  author: string;
  authorAssociation: string;
  createdAt: string;
  updatedAt: string;
}

export interface PreviewGitHub {
  listDeployments(target: PreviewTarget): Promise<PreviewDeployment[]>;
  listDeploymentStatuses(target: PreviewTarget, deploymentId: number): Promise<PreviewDeploymentStatus[]>;
  listComments(target: PreviewTarget): Promise<PreviewComment[]>;
  headCommitDate(target: PreviewTarget): Promise<string | undefined>;
}

type PreviewSource = PreviewConfig['source'];
type CommentSource = Extract<PreviewSource, { kind: 'comment' }>;

const SHORT_SHA = 7;

const globToRegExp = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );

const newestFirst = <T>(items: readonly T[], at: (item: T) => string): T[] =>
  [...items].sort((a, b) => Date.parse(at(b)) - Date.parse(at(a)));

async function findDeploymentUrl(github: PreviewGitHub, target: PreviewTarget, environment: string) {
  const matches = globToRegExp(environment);
  const deployments = (await github.listDeployments(target)).filter((d) => matches.test(d.environment));
  for (const deployment of newestFirst(deployments, (d) => d.createdAt)) {
    const [newest] = newestFirst(await github.listDeploymentStatuses(target, deployment.id), (s) => s.createdAt);
    if (newest?.state !== 'success') continue;
    const url = newest.environmentUrl || newest.targetUrl;
    if (url) return url;
  }
  return null;
}

const isTrusted = (comment: PreviewComment, source: CommentSource): boolean =>
  source.authors.some((login) => login.toLowerCase() === comment.author.toLowerCase()) ||
  source.authorAssociations.some((level) => level === comment.authorAssociation);

async function findCommentUrl(github: PreviewGitHub, target: PreviewTarget, source: CommentSource) {
  const pattern = new RegExp(source.urlPattern);
  const trusted = (await github.listComments(target)).filter((c) => isTrusted(c, source));
  let headDate: Promise<string | undefined> | undefined;
  for (const comment of newestFirst(trusted, (c) => c.updatedAt)) {
    const match = pattern.exec(comment.body);
    const url = match?.groups?.url ?? match?.[1];
    if (!url) continue;
    if (comment.body.includes(target.headSha.slice(0, SHORT_SHA))) return url;
    headDate ??= github.headCommitDate(target);
    const committed = await headDate;
    if (committed !== undefined && Date.parse(comment.updatedAt) > Date.parse(committed)) return url;
  }
  return null;
}

export async function findPreviewUrl(
  github: PreviewGitHub,
  target: PreviewTarget,
  source: PreviewSource,
): Promise<string | null> {
  return source.kind === 'deployment'
    ? findDeploymentUrl(github, target, source.environment)
    : findCommentUrl(github, target, source);
}
