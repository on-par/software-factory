// src/constitutions/index.ts — Constitution loading and enforcement

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import matter from 'gray-matter';
import type { Constitution } from '../types/index.js';
import { getConstitutionsDir } from '../config/index.js';

/**
 * Agent instruction files a target repo may carry, in priority order.
 * When any of these exist, they ARE the standards — a bundled <product>.md
 * is only a fallback for repos that have none.
 */
export const REPO_INSTRUCTION_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.github/copilot-instructions.md',
] as const;

export class ConstitutionLoader {
  constructor(private dir: string = getConstitutionsDir()) {}

  /** Load a constitution by product name */
  load(product: string): Constitution {
    const path = resolve(this.dir, `${product}.md`);
    if (!existsSync(path)) {
      throw new Error(`No constitution for '${product}' at ${path}`);
    }
    const raw = readFileSync(path, 'utf-8');
    const { data, content } = matter(raw);
    return {
      product: data.product ?? product,
      version: data.version ?? 1,
      checkers: data.checkers ?? [],
      enforcedOn: data.enforcedOn ?? ['plan', 'build', 'check'],
      body: content,
      path,
      source: 'bundled',
    };
  }

  /** Load standards from the target repo's own agent instruction files, if any */
  loadFromRepo(repoDir: string): Constitution | null {
    const sections: string[] = [];
    for (const file of REPO_INSTRUCTION_FILES) {
      const path = join(repoDir, file);
      if (!existsSync(path)) continue;
      const content = readFileSync(path, 'utf-8').trim();
      if (!content) continue;
      sections.push(`<standards source="${file}">\n\n${content}\n\n</standards>`);
    }
    if (sections.length === 0) return null;
    return {
      product: 'repo',
      version: 1,
      checkers: [],
      enforcedOn: ['plan', 'build', 'check'],
      body: sections.join('\n\n'),
      path: repoDir,
      source: 'repo',
    };
  }

  /**
   * Resolve standards repo-first: the target repo's instruction files win;
   * a bundled <product>.md is the fallback. Never throws — a missing bundled
   * product just resolves to null.
   */
  resolve(repoDir: string, product?: string): Constitution | null {
    const fromRepo = this.loadFromRepo(repoDir);
    if (fromRepo) return fromRepo;
    if (product && existsSync(resolve(this.dir, `${product}.md`))) {
      return this.load(product);
    }
    return null;
  }

  /** Repo-first body; '' when nothing is found */
  getBodyFor(repoDir: string, product?: string): string {
    return this.resolve(repoDir, product)?.body ?? '';
  }

  /** Repo-first custom checkers; repo-derived standards declare none */
  getCheckersFor(repoDir: string, product?: string): string[] {
    return this.resolve(repoDir, product)?.checkers ?? [];
  }

  /** Repo-first prompt context; '' when nothing is found */
  buildContextFor(repoDir: string, product?: string): string {
    const c = this.resolve(repoDir, product);
    if (!c) return '';
    if (c.source === 'bundled') return this.buildContext(c.product);

    return `<constitution source="repo instruction files">

${c.body}

</constitution>

IMPORTANT: The standards above come from this repository's own agent
instruction files (${REPO_INSTRUCTION_FILES.join(', ')}). They are the
written standard for this repo. Every piece of work must satisfy them —
checkers will verify your output against them, not against your self-report.

`;
  }

  /** List available product constitutions */
  listProducts(): string[] {
    return readdirSync(this.dir)
      .filter(f => f.endsWith('.md') && !f.startsWith('_'))
      .map(f => f.replace(/\.md$/, ''));
  }

  /** Get checkers for a product */
  getCheckers(product: string): string[] {
    return this.load(product).checkers;
  }

  /** Check if a phase should use this constitution */
  enforcedIn(product: string, phase: string): boolean {
    const c = this.load(product);
    return c.enforcedOn.includes(phase);
  }

  /** Get the body (standards + rules) without frontmatter */
  getBody(product: string): string {
    return this.load(product).body;
  }

  /** Build the constitution context for injection into prompts */
  buildContext(product: string): string {
    const body = this.getBody(product);
    if (!body) return '';

    return `<constitution product="${product}">

${body}

</constitution>

IMPORTANT: The constitution above is the written standard for "${product}".
Every piece of work must satisfy these standards. Checkers will verify
your output against them — not against your self-report. If a checker
flags your work, refer to the Dispute Rules section to understand how
to escalate.

`;
  }
}