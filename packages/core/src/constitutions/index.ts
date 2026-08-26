// src/constitutions/index.ts — Constitution loading and enforcement

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import matter from 'gray-matter';

import { getConstitutionsDir } from '../config/index.js';
import type { Constitution } from '../types/index.js';

/**
 * Agent instruction files a target repo may carry, in priority order.
 * When any of these exist, they ARE the standards body — a bundled
 * <product>.md is only a fallback for repos that have none.
 */
export const REPO_INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md'] as const;

/** Default path, relative to a consumer repo's root, of its committed constitution instance. */
export const DEFAULT_REPO_CONSTITUTION_PATH = '.factory/constitution.md';

/** Build a Constitution from a bundled/repo-instance file's raw text and frontmatter. */
function parseConstitution(raw: string, path: string, fallbackProduct: string): Constitution {
  const { data, content } = matter(raw);
  return {
    product: data.product ?? fallbackProduct,
    version: data.version ?? 1,
    checkers: data.checkers ?? [],
    requireTests: data.requireTests === true,
    body: content,
    path,
    source: 'bundled',
  };
}

export class ConstitutionLoader {
  constructor(private dir: string = getConstitutionsDir()) {}

  private bundledPath(product: string): string {
    return resolve(this.dir, `${product}.md`);
  }

  /** Load a bundled constitution by product name. Throws if it does not exist. */
  load(product: string): Constitution {
    const path = this.bundledPath(product);
    if (!existsSync(path)) {
      throw new Error(`No constitution for '${product}' at ${path}`);
    }
    const raw = readFileSync(path, 'utf-8');
    return parseConstitution(raw, path, product);
  }

  /**
   * Load a consumer repo's own committed constitution instance
   * (`.factory/constitution.md` by default), if one exists. It is parsed
   * exactly like a package-bundled `<product>.md` — only its location
   * differs — so a valid instance is returned with `source: 'bundled'`.
   */
  loadRepoConstitution(repoDir: string, relPath: string = DEFAULT_REPO_CONSTITUTION_PATH): Constitution | null {
    const path = resolve(repoDir, relPath);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
    if (!raw.trim()) return null;
    const fallbackProduct = basename(relPath).replace(/\.md$/, '');
    return parseConstitution(raw, path, fallbackProduct);
  }

  /** Load standards from the target repo's own agent instruction files, if any */
  loadFromRepo(repoDir: string): Constitution | null {
    const sections: string[] = [];
    for (const file of REPO_INSTRUCTION_FILES) {
      let content: string;
      try {
        // existsSync alone is not enough: the name may be a directory (EISDIR)
        // or unreadable (EACCES) — skip anything that can't be read as a file.
        content = readFileSync(join(repoDir, file), 'utf-8').trim();
      } catch {
        continue;
      }
      if (!content) continue;
      sections.push(`<standards source="${file}">\n\n${content}\n\n</standards>`);
    }
    if (sections.length === 0) return null;
    return {
      product: 'repo',
      version: 1,
      checkers: [],
      requireTests: false,
      body: sections.join('\n\n'),
      path: repoDir,
      source: 'repo',
    };
  }

  /**
   * Resolve the standards for one issue run, repo-first. Call this ONCE per
   * run (against the freshly created worktree) and pass the result through —
   * re-resolving later would let a worker that writes a CLAUDE.md mid-build
   * author the standards it is graded by.
   *
   * - Repo instruction files win the standards body. A configured product
   *   still contributes its custom checkers — the operator asked for them
   *   explicitly, and repo files can't declare checkers.
   * - No repo files → the bundled <product>.md.
   * - A committed repo constitution instance (`.factory/constitution.md` by
   *   default) takes the "bundled" slot when present, preferring it over the
   *   package `--product` lookup — the repo instance is authoritative.
   * - A configured product whose bundled file is missing throws (fail fast:
   *   an unattended run must not silently drop the standards it was given) —
   *   but only when no repo constitution instance exists.
   * - No product and no repo files → null.
   */
  resolve(
    repoDir: string,
    product?: string,
    constitutionPath: string = DEFAULT_REPO_CONSTITUTION_PATH,
  ): Constitution | null {
    const repoConstitution = this.loadRepoConstitution(repoDir, constitutionPath);
    const bundled = repoConstitution ?? (product ? this.load(product) : null);
    const fromRepo = this.loadFromRepo(repoDir);
    if (fromRepo && bundled) {
      // Repo files lead, but the configured constitution rides along: it is
      // what defines the custom checkers, so those standards must stay in the
      // body the checkers are graded against.
      const bundledBody = bundled.body.trim();
      return {
        ...fromRepo,
        body: bundledBody
          ? `${fromRepo.body}\n\n<standards source="constitution:${bundled.product}">\n\n${bundledBody}\n\n</standards>`
          : fromRepo.body,
        checkers: bundled.checkers,
        requireTests: bundled.requireTests,
      };
    }
    return fromRepo ?? bundled;
  }

  /** List available product constitutions */
  listProducts(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
      .map((f) => f.replace(/\.md$/, ''));
  }
}

/** Build the prompt context for an already-resolved constitution */
export function buildConstitutionContext(c: Constitution | null): string {
  // frontmatter-only constitutions have no prose to enforce — injecting an
  // empty <constitution> block would flip prompts into the "standards exist"
  // branch with nothing to comply with
  if (!c || !c.body.trim()) return '';

  const origin =
    c.source === 'repo'
      ? `this repository's own agent instruction files (${REPO_INSTRUCTION_FILES.join(', ')})`
      : `the written standard for "${c.product}"`;
  const dispute =
    c.source === 'repo'
      ? ''
      : ' If a checker\nflags your work, refer to the Dispute Rules section to understand how\nto escalate.';

  return `<constitution source="${c.source === 'repo' ? 'repo instruction files' : c.product}">

${c.body}

</constitution>

IMPORTANT: The constitution above is ${origin}.
Every piece of work must satisfy these standards. Checkers will verify
your output against them — not against your self-report.${dispute}

`;
}
