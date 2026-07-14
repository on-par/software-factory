import { exec as execCb } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execCb);
type PatchRun = (command: string, options: { cwd: string; timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;

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

export interface LocalSmallPatchChange {
  file: string;
  find: string;
  replace: string;
}

export interface LocalSmallPatchProposal {
  stepId: LocalSmallStep['id'];
  summary: string;
  changes: LocalSmallPatchChange[];
  verifyCommand: string;
}

export type LocalSmallPatchStepStatus = 'success' | 'repair-needed';

export interface LocalSmallPatchStepResult {
  status: LocalSmallPatchStepStatus;
  appliedFiles: string[];
  verifyCommand?: string;
  reason?: string;
  reportEvent: {
    type: 'local-small-step';
    msg: string;
  };
}

export interface LocalSmallPatchStepInput {
  repoRoot: string;
  contextPack: LocalSmallContextPack;
  proposal: unknown;
  run?: PatchRun;
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

export async function applyLocalSmallPatchStep(input: LocalSmallPatchStepInput): Promise<LocalSmallPatchStepResult> {
  const validation = validatePatchProposal(input.proposal, input.contextPack);
  if (!validation.ok) {
    return repairNeeded(input.contextPack.stepId, validation.reason, []);
  }

  const proposal = validation.proposal;
  const preparedChanges: Array<{ change: LocalSmallPatchChange; path: string; content: string }> = [];
  for (const change of proposal.changes) {
    const path = resolve(input.repoRoot, change.file);
    const content = await readFile(path, 'utf-8').catch(() => undefined);
    if (content === undefined) {
      return repairNeeded(proposal.stepId, `${change.file}: file could not be read`, []);
    }
    if (!content.includes(change.find)) {
      return repairNeeded(proposal.stepId, `${change.file}: find text was not present`, []);
    }
    preparedChanges.push({ change, path, content });
  }

  const appliedFiles: string[] = [];
  for (const { change, path, content } of preparedChanges) {
    await writeFile(path, content.replace(change.find, change.replace));
    appliedFiles.push(change.file);
  }

  try {
    await (input.run ?? exec)(proposal.verifyCommand, {
      cwd: input.repoRoot,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (err: any) {
    return repairNeeded(
      proposal.stepId,
      `verification failed: ${err.message ?? 'unknown error'}`,
      appliedFiles,
      proposal.verifyCommand,
    );
  }

  return {
    status: 'success',
    appliedFiles,
    verifyCommand: proposal.verifyCommand,
    reportEvent: {
      type: 'local-small-step',
      msg: `${proposal.stepId} success: ${proposal.summary}; verified with ${proposal.verifyCommand}`,
    },
  };
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

function validatePatchProposal(
  proposal: unknown,
  contextPack: LocalSmallContextPack,
): { ok: true; proposal: LocalSmallPatchProposal } | { ok: false; reason: string } {
  if (!isRecord(proposal)) return { ok: false, reason: 'proposal must be an object' };
  if (proposal.stepId !== contextPack.stepId) {
    return { ok: false, reason: `proposal stepId must match ${contextPack.stepId}` };
  }
  if (typeof proposal.summary !== 'string' || proposal.summary.trim() === '') {
    return { ok: false, reason: 'proposal summary is required' };
  }
  if (typeof proposal.verifyCommand !== 'string' || proposal.verifyCommand.trim() === '') {
    return { ok: false, reason: 'proposal verifyCommand is required' };
  }
  if (!Array.isArray(proposal.changes) || proposal.changes.length === 0) {
    return { ok: false, reason: 'proposal changes must be a non-empty array' };
  }
  if (proposal.changes.length > contextPack.limits.maxFilesPerStep) {
    return { ok: false, reason: `proposal changes exceed maxFilesPerStep ${contextPack.limits.maxFilesPerStep}` };
  }

  const allowed = new Set(contextPack.allowedFiles);
  const seenFiles = new Set<string>();
  const changes: LocalSmallPatchChange[] = [];
  for (const change of proposal.changes) {
    if (!isRecord(change)) return { ok: false, reason: 'each change must be an object' };
    if (typeof change.file !== 'string' || change.file.trim() === '') {
      return { ok: false, reason: 'each change requires a file' };
    }
    if (!allowed.has(change.file)) {
      return { ok: false, reason: `${change.file} is not in allowed files` };
    }
    if (!isSafeRelativeFile(change.file)) {
      return { ok: false, reason: `${change.file}: unsafe path` };
    }
    if (seenFiles.has(change.file)) {
      return { ok: false, reason: `${change.file}: duplicate file entries are not supported` };
    }
    if (typeof change.find !== 'string' || change.find === '') {
      return { ok: false, reason: `${change.file}: find text is required` };
    }
    if (typeof change.replace !== 'string') {
      return { ok: false, reason: `${change.file}: replace text is required` };
    }
    seenFiles.add(change.file);
    changes.push({ file: change.file, find: change.find, replace: change.replace });
  }

  return {
    ok: true,
    proposal: {
      stepId: contextPack.stepId,
      summary: proposal.summary.trim(),
      changes,
      verifyCommand: proposal.verifyCommand.trim(),
    },
  };
}

function repairNeeded(
  stepId: LocalSmallStep['id'],
  reason: string,
  appliedFiles: string[],
  verifyCommand?: string,
): LocalSmallPatchStepResult {
  return {
    status: 'repair-needed',
    appliedFiles,
    verifyCommand,
    reason,
    reportEvent: {
      type: 'local-small-step',
      msg: `${stepId} repair-needed: ${reason}`,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeRelativeFile(file: string): boolean {
  if (isAbsolute(file)) return false;
  const normalized = relative('.', file);
  return normalized !== '' && normalized !== '..' && !normalized.startsWith(`..${pathSeparator()}`);
}

function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/';
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
