// Pre-PLAN config preflight (#2586): reject unfilled <...> scaffold tokens in the constitution frontmatter and the repo config file.
import { readFileSync } from 'node:fs';

import type { Constitution } from '../types/index.js';

export interface TemplateTokenFinding {
  /** Display path used in the message, e.g. `.factory/constitution.md`. */
  file: string;
  /** 1-based line in the file. */
  line: number;
  /** The token text including the angle brackets, e.g. `<project-name>`. */
  token: string;
  /** `${file}:${line}: unfilled template token '${token}'. Replace it with a real value` */
  message: string;
}

const TOKEN_RE = /(?<![\w])<[A-Za-z][^<>\r\n]*>/g;

// Same grammar as TOKEN_RE, anchored to the whole trimmed string.
export function isTemplateToken(value: string): boolean {
  return /^<[A-Za-z][^<>\r\n]*>$/.test(value.trim());
}

export function findTemplateTokens(text: string, file: string, scope: 'frontmatter' | 'all'): TemplateTokenFinding[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  if (scope === 'frontmatter') {
    if (lines[0]?.trimEnd() !== '---') return [];
    const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
    if (close === -1) return [];
    start = 1;
    end = close;
  }
  const findings: TemplateTokenFinding[] = [];
  for (let i = start; i < end; i++) {
    const raw = lines[i] ?? '';
    if (raw.trimStart().startsWith('#')) continue;
    const line = raw.replace(/\s#.*$/, '');
    for (const m of line.matchAll(TOKEN_RE)) {
      const token = m[0];
      findings.push({
        file,
        line: i + 1,
        token,
        message: `${file}:${i + 1}: unfilled template token '${token}'. Replace it with a real value`,
      });
    }
  }
  return findings;
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

export function preflightConfigTokens(input: {
  constitution: Constitution | null;
  configFile?: { absPath: string; relPath: string };
}): TemplateTokenFinding[] {
  const findings: TemplateTokenFinding[] = [];
  const instance = input.constitution?.repoInstance;
  if (instance) {
    const text = readOrNull(instance.absPath);
    if (text !== null) findings.push(...findTemplateTokens(text, instance.relPath, 'frontmatter'));
  }
  if (input.configFile) {
    const text = readOrNull(input.configFile.absPath);
    if (text !== null) findings.push(...findTemplateTokens(text, input.configFile.relPath, 'all'));
  }
  return findings;
}
