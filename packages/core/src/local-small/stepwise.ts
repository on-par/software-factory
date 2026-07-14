import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

export interface LocalSmallLimits {
  maxSteps: number;
  maxFilesPerStep: number;
  maxContextTokens: number;
  maxSpecChars: number;
}

export interface LocalSmallStep {
  id: 'inspect-context' | 'schema-bound-change' | 'verify-and-report';
  title: string;
  goal: string;
  allowedFiles: string[];
  maxFiles: number;
  maxTokens: number;
  verification: string;
}

export interface LocalSmallStepPlan {
  issue: number;
  issueTitle: string;
  profile: 'local-small-stepwise';
  dryRun: true;
  createdAt: string;
  specPath: string;
  limits: LocalSmallLimits;
  steps: LocalSmallStep[];
}

export interface LocalSmallContextPack {
  issue: number;
  issueTitle: string;
  stepId: LocalSmallStep['id'];
  stepTitle: string;
  dryRun: true;
  allowedFiles: string[];
  limits: Pick<LocalSmallLimits, 'maxFilesPerStep' | 'maxContextTokens'>;
  instructions: string[];
  issueBody: string;
  specExcerpt: string;
}

export interface LocalSmallDryRunInput {
  issue: number;
  issueTitle: string;
  issueBody: string;
  repoRoot: string;
  specPath: string;
  outputDir: string;
  limits?: Partial<LocalSmallLimits>;
  now?: () => Date;
}

export interface LocalSmallDryRunResult {
  plan: LocalSmallStepPlan;
  contextPack: LocalSmallContextPack;
  planPath: string;
  contextPath: string;
}

const DEFAULT_LIMITS: LocalSmallLimits = {
  maxSteps: 3,
  maxFilesPerStep: 4,
  maxContextTokens: 2000,
  maxSpecChars: 6000,
};

export async function createLocalSmallDryRun(input: LocalSmallDryRunInput): Promise<LocalSmallDryRunResult> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const spec = await readFile(input.specPath, 'utf-8');
  const allowedFiles = inferAllowedFiles(spec, input.repoRoot, limits.maxFilesPerStep);
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const relativeSpecPath = relative(input.repoRoot, input.specPath) || input.specPath;
  const steps = buildSteps(allowedFiles, limits);
  const plan: LocalSmallStepPlan = {
    issue: input.issue,
    issueTitle: input.issueTitle,
    profile: 'local-small-stepwise',
    dryRun: true,
    createdAt,
    specPath: relativeSpecPath,
    limits,
    steps,
  };
  const contextPack: LocalSmallContextPack = {
    issue: input.issue,
    issueTitle: input.issueTitle,
    stepId: steps[0].id,
    stepTitle: steps[0].title,
    dryRun: true,
    allowedFiles: steps[0].allowedFiles,
    limits: {
      maxFilesPerStep: limits.maxFilesPerStep,
      maxContextTokens: limits.maxContextTokens,
    },
    instructions: [
      'Read the frozen spec excerpt and the allowed file list.',
      'Do not modify files in dry-run mode.',
      'Return only observations needed to decide the next bounded step.',
    ],
    issueBody: input.issueBody.trim(),
    specExcerpt: truncate(spec.trim(), limits.maxSpecChars),
  };

  const planPath = resolve(input.outputDir, 'step-plan.json');
  const contextPath = resolve(input.outputDir, 'step-1-context.md');
  await mkdir(input.outputDir, { recursive: true });
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  await writeFile(contextPath, renderContextPack(contextPack));
  return { plan, contextPack, planPath, contextPath };
}

function buildSteps(allowedFiles: string[], limits: LocalSmallLimits): LocalSmallStep[] {
  const files = allowedFiles.slice(0, limits.maxFilesPerStep);
  const steps: LocalSmallStep[] = [
    {
      id: 'inspect-context',
      title: 'Inspect the frozen spec and bounded file set',
      goal: 'Confirm the smallest useful change and identify any missing context before patching.',
      allowedFiles: files,
      maxFiles: limits.maxFilesPerStep,
      maxTokens: limits.maxContextTokens,
      verification: 'No source changes; context pack artifact exists.',
    },
    {
      id: 'schema-bound-change',
      title: 'Propose one schema-bound patch',
      goal: 'Produce a single constrained patch proposal against the allowed files.',
      allowedFiles: files,
      maxFiles: limits.maxFilesPerStep,
      maxTokens: limits.maxContextTokens,
      verification: 'Patch schema validates before any apply attempt.',
    },
    {
      id: 'verify-and-report',
      title: 'Run focused verification and report status',
      goal: 'Run one configured verification command and record ready or repair-needed status.',
      allowedFiles: files,
      maxFiles: limits.maxFilesPerStep,
      maxTokens: limits.maxContextTokens,
      verification: 'Verification result is attached to the local-only run report.',
    },
  ];
  return steps.slice(0, limits.maxSteps);
}

function inferAllowedFiles(spec: string, repoRoot: string, maxFiles: number): string[] {
  const candidates = new Set<string>();
  const pathPattern = /`([^`\n]+\.[A-Za-z0-9]+)`|(?:^|\s)([A-Za-z0-9_.@/-]+\/[A-Za-z0-9_.@/-]+\.[A-Za-z0-9]+)/gm;
  for (const match of spec.matchAll(pathPattern)) {
    const raw = (match[1] ?? match[2] ?? '').trim();
    if (!raw || raw.startsWith('http')) continue;
    if (/\s/.test(raw)) continue;
    const clean = raw.replace(/[),.;:]$/, '');
    if (clean.includes('..')) continue;
    candidates.add(clean);
  }

  if (candidates.size === 0) return ['.'];
  return [...candidates]
    .map(path => relative(repoRoot, resolve(repoRoot, path)) || path)
    .slice(0, maxFiles);
}

function renderContextPack(pack: LocalSmallContextPack): string {
  return [
    `# Local-small context pack: issue #${pack.issue}`,
    '',
    `- Step: ${pack.stepId} - ${pack.stepTitle}`,
    `- Dry run: ${pack.dryRun}`,
    `- Max files: ${pack.limits.maxFilesPerStep}`,
    `- Max context tokens: ${pack.limits.maxContextTokens}`,
    '',
    '## Allowed Files',
    ...pack.allowedFiles.map(file => `- ${file}`),
    '',
    '## Instructions',
    ...pack.instructions.map(instruction => `- ${instruction}`),
    '',
    '## Issue',
    pack.issueBody || '(no issue body)',
    '',
    '## Frozen Spec Excerpt',
    '```markdown',
    pack.specExcerpt,
    '```',
    '',
  ].join('\n');
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 48))}\n\n[truncated for local-small context pack]`;
}
