// packages/core/src/work/index.ts — Canonical work request + input-source seam (#505).

import type { Octokit } from '@octokit/rest';

import { createGithubIssueAdapter, createOctokitIssueClient } from './github-issue.js';

/** Registered input sources. Open-ended by design — adapters register by string key. */
export type WorkRequestSourceKind = 'github-issue' | (string & {});

/** Where the request came from, for traceability back to the native artifact. */
export interface WorkRequestReference {
  /** Source-native id, e.g. the GitHub issue number as a string. */
  externalId: string;
  /** "owner/repo" for GitHub sources; omitted for sources with no repo. */
  repo?: string;
  /** Canonical URL of the originating artifact, when the source has one. */
  url?: string;
}

/** The one shape PLAN, BUILD, and CHECK consume, whatever the input source was. */
export interface WorkRequest {
  /** Stable, source-qualified identity, e.g. "github-issue:on-par/software-factory#505". */
  id: string;
  kind: WorkRequestSourceKind;
  title: string;
  /** Full prose brief handed to PLAN — the issue body, verbatim. */
  brief: string;
  /** Acceptance-criteria lines lifted from the brief; empty when the source has none. */
  acceptanceCriteria: string[];
  reference?: WorkRequestReference;
}

/**
 * One input source. `resolve` takes the source-native params as `unknown` and
 * validates them itself (so the registry can hold adapters of different param
 * shapes without casts), throwing InvalidWorkRequestInputError on a bad shape.
 */
export interface WorkSourceAdapter {
  readonly kind: WorkRequestSourceKind;
  resolve(params: unknown): Promise<WorkRequest>;
}

export class UnsupportedWorkSourceError extends Error {
  readonly kind: WorkRequestSourceKind;
  readonly supported: WorkRequestSourceKind[];
  constructor(kind: WorkRequestSourceKind, supported: readonly WorkRequestSourceKind[]) {
    const list = supported.length > 0 ? supported.join(', ') : 'none';
    super(`unsupported work-request source "${kind}" — registered sources: ${list}`);
    this.name = 'UnsupportedWorkSourceError';
    this.kind = kind;
    this.supported = [...supported];
  }
}

export class InvalidWorkRequestInputError extends Error {
  readonly kind: WorkRequestSourceKind;
  constructor(kind: WorkRequestSourceKind, detail: string) {
    super(`invalid input for work-request source "${kind}": ${detail}`);
    this.name = 'InvalidWorkRequestInputError';
    this.kind = kind;
  }
}

export class WorkSourceRegistry {
  private readonly adapters = new Map<string, WorkSourceAdapter>();

  /** Registers an adapter. Last registration for a kind wins. */
  register(adapter: WorkSourceAdapter): this {
    this.adapters.set(adapter.kind, adapter);
    return this;
  }

  has(kind: WorkRequestSourceKind): boolean {
    return this.adapters.has(kind);
  }

  /** Registered kinds, in registration order. */
  kinds(): WorkRequestSourceKind[] {
    return [...this.adapters.keys()];
  }

  async resolve(kind: WorkRequestSourceKind, params: unknown): Promise<WorkRequest> {
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      throw new UnsupportedWorkSourceError(kind, this.kinds());
    }
    return adapter.resolve(params);
  }
}

/** Registry with today's only input source — the GitHub issue adapter — registered. */
export function createDefaultWorkSourceRegistry(deps: { octokit: Octokit }): WorkSourceRegistry {
  return new WorkSourceRegistry().register(createGithubIssueAdapter(createOctokitIssueClient(deps.octokit)));
}
