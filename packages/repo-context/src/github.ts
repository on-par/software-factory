// src/github.ts — GitHub contents-API RepoContextReader impl (#468).

import { Buffer } from 'node:buffer';

import { normalizeRepoPath } from './path.js';
import type {
  DegradeEvent,
  DegradeReason,
  OnDegrade,
  RepoContextOperation,
  RepoContextReader,
  RepoDirEntry,
} from './reader.js';
import { EMPTY_DIR } from './reader.js';

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<FetchLikeResponse>;

export const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
/** GitHub's contents API refuses to inline files above ~1 MB. */
export const DEFAULT_MAX_FILE_BYTES = 1_000_000;

export interface GitHubContentsReaderOptions {
  owner: string;
  repo: string;
  /** Branch, tag, or commit SHA. Omit to use the repo's default branch. */
  ref?: string;
  /** Read-only token. Omit for unauthenticated (public, heavily rate-limited) access. */
  token?: string;
  baseUrl?: string;
  maxFileBytes?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
  onDegrade?: OnDegrade;
}

type RequestResult =
  | { ok: true; path: string; body: unknown }
  | { ok: false; path: string; reason: DegradeReason; status?: number; detail?: string };

function encodeContentsPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function createGitHubContentsReader(options: GitHubContentsReaderOptions): RepoContextReader {
  const { owner, repo, ref, token, onDegrade } = options;
  const baseUrl = (options.baseUrl ?? DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, '');
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
  const doFetch: FetchLike | undefined =
    options.fetch ?? (globalFetch ? (url, init) => globalFetch(url, init) : undefined);

  function emit(event: DegradeEvent): void {
    if (!onDegrade) {
      return;
    }
    try {
      onDegrade(event);
    } catch {
      // Never let a throwing observer break the "never throws" contract.
    }
  }

  function emitFailure(operation: RepoContextOperation, result: Extract<RequestResult, { ok: false }>): void {
    emit({ operation, path: result.path, reason: result.reason, status: result.status, detail: result.detail });
  }

  function buildUrl(path: string): string {
    const encodedPath = encodeContentsPath(path);
    const suffix = encodedPath === '' ? '' : `/${encodedPath}`;
    const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${suffix}`;
    return ref ? `${url}?ref=${encodeURIComponent(ref)}` : url;
  }

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  function classifyStatus(res: FetchLikeResponse): DegradeReason {
    switch (res.status) {
      case 404:
        return 'not-found';
      case 401:
        return 'unauthorized';
      case 403:
        return res.headers.get('x-ratelimit-remaining') === '0' ? 'rate-limited' : 'unauthorized';
      case 429:
        return 'rate-limited';
      default:
        return 'invalid-response';
    }
  }

  async function request(rawPath: string): Promise<RequestResult> {
    const normalized = normalizeRepoPath(rawPath);
    if (normalized === undefined) {
      return { ok: false, path: rawPath, reason: 'invalid-path' };
    }

    if (!doFetch) {
      return { ok: false, path: normalized, reason: 'network', detail: 'global fetch is unavailable' };
    }

    let res: FetchLikeResponse;
    try {
      res = await doFetch(buildUrl(normalized), { headers: buildHeaders() });
    } catch (error) {
      return { ok: false, path: normalized, reason: 'network', detail: (error as Error).message };
    }

    if (!res.ok) {
      return { ok: false, path: normalized, reason: classifyStatus(res), status: res.status };
    }

    let raw: string;
    try {
      raw = await res.text();
    } catch (error) {
      return { ok: false, path: normalized, reason: 'invalid-response', detail: (error as Error).message };
    }

    try {
      return { ok: true, path: normalized, body: JSON.parse(raw) as unknown };
    } catch (error) {
      return { ok: false, path: normalized, reason: 'invalid-response', detail: (error as Error).message };
    }
  }

  return {
    async readFile(rawPath) {
      const result = await request(rawPath);
      if (!result.ok) {
        emitFailure('readFile', result);
        return undefined;
      }

      const body = result.body;
      if (
        body === null ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        (body as { type?: unknown }).type !== 'file'
      ) {
        emit({ operation: 'readFile', path: result.path, reason: 'wrong-type' });
        return undefined;
      }

      const record = body as { size?: unknown; encoding?: unknown; content?: unknown };
      const size = typeof record.size === 'number' ? record.size : 0;
      if (size > maxFileBytes) {
        emit({ operation: 'readFile', path: result.path, reason: 'too-large' });
        return undefined;
      }

      if (record.encoding === 'none') {
        emit({ operation: 'readFile', path: result.path, reason: 'too-large' });
        return undefined;
      }

      if (record.encoding !== 'base64' || typeof record.content !== 'string') {
        emit({ operation: 'readFile', path: result.path, reason: 'unsupported-content' });
        return undefined;
      }

      const text = Buffer.from(record.content, 'base64').toString('utf8');
      if (text.includes('\u0000')) {
        emit({ operation: 'readFile', path: result.path, reason: 'unsupported-content' });
        return undefined;
      }

      return { path: result.path, text, size };
    },

    async readDir(rawPath) {
      const result = await request(rawPath);
      if (!result.ok) {
        emitFailure('readDir', result);
        return EMPTY_DIR;
      }

      if (!Array.isArray(result.body)) {
        emit({ operation: 'readDir', path: result.path, reason: 'wrong-type' });
        return EMPTY_DIR;
      }

      const entries: RepoDirEntry[] = [];
      for (const item of result.body) {
        if (item === null || typeof item !== 'object') {
          continue;
        }
        const record = item as { name?: unknown; path?: unknown; type?: unknown };
        if (typeof record.name !== 'string' || typeof record.path !== 'string') {
          continue;
        }
        if (record.type !== 'file' && record.type !== 'dir') {
          continue;
        }
        entries.push({ name: record.name, path: record.path, type: record.type });
      }

      return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },

    async exists(rawPath) {
      const result = await request(rawPath);
      if (!result.ok) {
        if (result.reason === 'not-found') {
          return false;
        }
        emitFailure('exists', result);
        return false;
      }

      return Array.isArray(result.body) || (result.body !== null && typeof result.body === 'object');
    },
  };
}
