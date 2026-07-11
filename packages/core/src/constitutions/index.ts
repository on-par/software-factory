// src/constitutions/index.ts — Constitution loading and enforcement

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import matter from 'gray-matter';
import type { Constitution } from '../types/index.js';
import { getConstitutionsDir } from '../config/index.js';

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
    };
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