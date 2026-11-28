import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AGENT_MEMORY_MAX_BYTES } from '../agent-memory/index.js';
import { PRODUCT_NAME_PATTERN } from './project-inputs.js';
import { resolveProjectConfigDir } from './run-config-ladder.js';

interface InputIssue {
  file: string;
  reason: string;
}

type EntryKind = 'missing' | 'file' | 'dir' | 'other';

function kindOf(path: string): EntryKind {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info === undefined) return 'missing';
  if (info.isFile()) return 'file';
  return info.isDirectory() ? 'dir' : 'other';
}

function isUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function agentMemoryIssue(dir: string): InputIssue | undefined {
  const root = join(dir, 'agent-memory');
  const kind = kindOf(root);
  if (kind === 'missing') return undefined;
  if (kind !== 'dir') return { file: 'agent-memory', reason: 'not a directory' };
  for (const name of readdirSync(root).sort()) {
    const file = `agent-memory/${name}`;
    const path = join(root, name);
    if (!name.endsWith('.md')) return { file, reason: 'not a .md lane memory file' };
    if (kindOf(path) !== 'file') return { file, reason: 'not a regular file' };
    const bytes = readFileSync(path);
    if (bytes.length > AGENT_MEMORY_MAX_BYTES)
      return { file, reason: `${bytes.length} bytes, over the ${AGENT_MEMORY_MAX_BYTES}-byte cap` };
    if (!isUtf8(bytes)) return { file, reason: 'not UTF-8 text' };
  }
  return undefined;
}

function productIssue(dir: string): InputIssue | undefined {
  const path = join(dir, 'product');
  const kind = kindOf(path);
  if (kind === 'missing') return undefined;
  if (kind !== 'file') return { file: 'product', reason: 'not a regular file' };
  const bytes = readFileSync(path);
  if (!isUtf8(bytes)) return { file: 'product', reason: 'not UTF-8 text' };
  const name = bytes.toString('utf-8').trim();
  if (PRODUCT_NAME_PATTERN.test(name)) return undefined;
  return {
    file: 'product',
    reason: `invalid product name '${name}': use letters, digits, '.', '_' or '-' and do not start with '_' or '.'`,
  };
}

function treeIssue(dir: string, rel: string): InputIssue | undefined {
  const kind = kindOf(join(dir, rel));
  if (kind === 'other') return { file: rel, reason: 'not a regular file or directory' };
  if (kind !== 'dir') return undefined;
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const issue = treeIssue(dir, `${rel}/${name}`);
    if (issue) return issue;
  }
  return undefined;
}

function testsIssue(dir: string): InputIssue | undefined {
  const kind = kindOf(join(dir, 'tests'));
  if (kind === 'missing') return undefined;
  if (kind !== 'dir') return { file: 'tests', reason: 'not a directory' };
  return treeIssue(dir, 'tests');
}

export function validateProjectInputs(env: NodeJS.ProcessEnv = process.env): void {
  const project = resolveProjectConfigDir(env);
  if (!project) return;
  const issue = agentMemoryIssue(project.dir) ?? productIssue(project.dir) ?? testsIssue(project.dir);
  if (issue) throw new Error(`Invalid ${project.source} (${join(project.dir, issue.file)}): ${issue.reason}`);
}
