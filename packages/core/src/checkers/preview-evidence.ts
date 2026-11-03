import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { stripAnsi } from './command-log.js';

export type PreviewCheckStatus = 'pass' | 'fail' | 'preview-unavailable';

export interface PreviewCheckEvidence {
  url?: string;
  headSha: string;
  command: string[];
  exitCode?: number;
  readyWaitMs: number;
  commandMs?: number;
  durationMs: number;
  outputTail?: string;
  artifacts: string[];
  artifactsDir?: string;
  reason?: string;
  evidencePath?: string;
}

export interface PreviewCheckResult {
  status: PreviewCheckStatus;
  evidence: PreviewCheckEvidence;
}

const TAIL_CHARS = 2000;
const SUMMARY_TAIL_CHARS = 1500;
const EVIDENCE_FILE = 'preview-check.json';
const ARTIFACTS_DIR = 'preview-artifacts';

export const PREVIEW_REWORK_INSTRUCTIONS =
  "The PR's deployed preview failed the repo's preview smoke command. Fix the code so the deployed app passes; do not edit the preview config, the smoke command or its tests to make it pass.";

export function writePreviewEvidence(result: PreviewCheckResult, logsDir: string | undefined): PreviewCheckResult {
  if (!logsDir) return result;
  try {
    mkdirSync(logsDir, { recursive: true });
    const evidencePath = join(logsDir, EVIDENCE_FILE);
    const evidence = { ...result.evidence, evidencePath };
    writeFileSync(evidencePath, `${JSON.stringify({ status: result.status, evidence }, null, 2)}\n`);
    return { status: result.status, evidence };
  } catch {
    return result;
  }
}

export function copyPreviewArtifacts(
  worktree: string,
  paths: readonly string[],
  logsDir: string | undefined,
): Pick<PreviewCheckEvidence, 'artifacts' | 'artifactsDir'> {
  const artifacts = paths.filter((path) => existsSync(join(worktree, path)));
  if (!logsDir || artifacts.length === 0) return { artifacts };
  const artifactsDir = join(logsDir, ARTIFACTS_DIR);
  const copied = artifacts.filter((path) => {
    try {
      cpSync(join(worktree, path), join(artifactsDir, path), { recursive: true });
      return true;
    } catch {
      return false;
    }
  });
  return copied.length > 0 ? { artifacts, artifactsDir } : { artifacts };
}

export const outputTail = (stdout: string, stderr: string): string =>
  stripAnsi([stdout.trim(), stderr.trim()].filter((part) => part !== '').join('\n'))
    .trim()
    .slice(-TAIL_CHARS);

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export const previewTimings = (e: PreviewCheckEvidence): string =>
  `Ready wait: ${seconds(e.readyWaitMs)}${e.commandMs === undefined ? '' : `; command: ${seconds(e.commandMs)}`}`;

export function previewReworkSummary(result: PreviewCheckResult): string {
  const e = result.evidence;
  return [
    `Preview check: ${result.status}`,
    `URL: ${e.url ?? '-'}`,
    `SHA: ${e.headSha}`,
    `Command: ${e.command.join(' ')}`,
    previewTimings(e),
    ...(e.exitCode === undefined ? [] : [`Exit code: ${e.exitCode}`]),
    ...(e.reason ? [`Reason: ${e.reason}`] : []),
    ...(e.outputTail ? ['Output tail:', e.outputTail.slice(-SUMMARY_TAIL_CHARS)] : []),
  ].join('\n');
}
