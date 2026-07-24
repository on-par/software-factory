// src/harness/ollama-agentic.ts — CodingHarness adapter that asks Ollama for a
// schema-bound patch proposal (via /api/chat `format`), applies it deterministically,
// and runs the proposal's verify command. Malformed output gets exactly one repair
// attempt before a trace artifact is written and the run fails with a classified reason.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { classifyFailure } from './classify.js';
import type { CodingHarness, HarnessRequest, HarnessResult } from './index.js';
import { HarnessError } from './index.js';
import type { OllamaFetchFn } from './ollama-http.js';

export type OllamaAgenticExecFn = ExecFn;

export interface OllamaAgenticChange {
  file: string;
  find: string;
  replace: string;
}

export interface OllamaAgenticProposal {
  summary: string;
  changes: OllamaAgenticChange[];
  verifyCommand: string;
}

/** JSON-Schema passed as the Ollama chat body's `format` field so decoding is
 *  constrained by the model runtime, not enforced by prose instructions. */
export const PATCH_PROPOSAL_SCHEMA = {
  type: 'object',
  required: ['summary', 'changes', 'verifyCommand'],
  properties: {
    summary: { type: 'string' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'find', 'replace'],
        properties: {
          file: { type: 'string' },
          find: { type: 'string' },
          replace: { type: 'string' },
        },
      },
    },
    verifyCommand: { type: 'string' },
  },
} as const;

const MAX_CHANGES = 4;

/** Explicit allowlist of safe verification command prefixes. A verify command
 *  must equal one of these exactly or start with `<prefix> ` (space-delimited,
 *  so 'true' does not match 'truely'). Keep this list intentionally small:
 *  verification is limited to known project checks and simple file-existence
 *  probes — it is not a general shell. */
export const ALLOWED_VERIFY_COMMAND_PREFIXES = [
  'npm test',
  'npm run test',
  'npm run build',
  'npm run lint',
  'npm run typecheck',
  'npx vitest run',
  'test -f',
  'test -d',
  'true',
] as const;

// Character allowlist: letters, digits, dot, underscore, slash, dash, equals,
// colon, and single spaces. Rejects by construction: ; & | < > ` $ ( ) { } quotes,
// backslash, newlines, globs — i.e. every shell-metacharacter escape hatch.
const VERIFY_COMMAND_CHARS = /^[A-Za-z0-9._/:=-]+(?: [A-Za-z0-9._/:=-]+)*$/;

export type VerifyCommandCheck = { ok: true } | { ok: false; detail: string };

export function validateVerifyCommand(command: string): VerifyCommandCheck {
  if (!VERIFY_COMMAND_CHARS.test(command)) {
    return {
      ok: false,
      detail: `verifyCommand rejected (${JSON.stringify(command)}): contains characters outside the safe set (no shell metacharacters, quotes, substitution, or redirection)`,
    };
  }
  const tokens = command.split(' ');
  if (tokens.some((t) => t.startsWith('/'))) {
    return { ok: false, detail: `verifyCommand rejected (${JSON.stringify(command)}): absolute paths are not allowed` };
  }
  if (tokens.some((t) => t === '..' || t.startsWith('../') || t.includes('/../') || t.endsWith('/..'))) {
    return { ok: false, detail: `verifyCommand rejected (${JSON.stringify(command)}): path traversal is not allowed` };
  }
  const allowed = ALLOWED_VERIFY_COMMAND_PREFIXES.some((p) => command === p || command.startsWith(`${p} `));
  if (!allowed) {
    return {
      ok: false,
      detail: `verifyCommand rejected (${JSON.stringify(command)}): not an allowed verification command; use one of: ${ALLOWED_VERIFY_COMMAND_PREFIXES.join(', ')}`,
    };
  }
  return { ok: true };
}

type MalformedReason = 'empty_response' | 'invalid_json' | 'schema_invalid' | 'apply_failed';

type ParseResult =
  | { ok: true; proposal: OllamaAgenticProposal }
  | { ok: false; malformedReason: Exclude<MalformedReason, 'apply_failed'>; detail: string };

type ApplyResult =
  | { ok: true; proposal: OllamaAgenticProposal; raw: string }
  | { ok: false; malformedReason: MalformedReason; detail: string };

/** Asks Ollama's /api/chat for a schema-bound patch proposal, validates and
 *  applies it deterministically, then runs its verify command. */
export class OllamaAgenticHarness implements CodingHarness {
  readonly id = 'ollama-agentic';
  readonly agentic = true;

  constructor(
    private fetchFn: OllamaFetchFn = globalThis.fetch as unknown as OllamaFetchFn,
    private execFn: OllamaAgenticExecFn = defaultExecFn,
  ) {}

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, worktree, timeoutSeconds, registry, env, onPgid } = request;
    const baseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const nativeModel = registry.getProviderModel(model);
    const options = registry.getProviderOptions(model);

    const callModel = async (content: string): Promise<string> => {
      try {
        const res = await this.fetchFn(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(timeoutSeconds * 1000),
          body: JSON.stringify({
            model: nativeModel,
            stream: false,
            format: PATCH_PROPOSAL_SCHEMA,
            messages: [{ role: 'user', content }],
            ...(options ? { options } : {}),
          }),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new HarnessError(`ollama ${res.status} ${res.statusText}: ${body}`, classifyFailure(body, res.status), {
            exitCode: res.status,
            stderr: body,
          });
        }

        const data = (await res.json()) as { message?: { content?: string }; response?: string; error?: string };
        if (data.error) {
          throw new HarnessError(data.error, classifyFailure(data.error, 1), { exitCode: 1, stderr: data.error });
        }

        return data.message?.content ?? data.response ?? '';
      } catch (err: any) {
        if (err instanceof HarnessError) throw err;
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          throw new HarnessError(err.message ?? String(err), 'timeout', {});
        }
        throw new HarnessError(
          err.message ?? String(err),
          err.reason ?? classifyFailure(err.stderr ?? err.message ?? '', err.code ?? 1),
          {
            exitCode: typeof err.code === 'number' ? err.code : undefined,
            stderr: err.stderr,
            code: typeof err.code === 'string' || typeof err.code === 'number' ? err.code : undefined,
            signal: typeof err.signal === 'string' ? err.signal : undefined,
            killed: err.killed === true ? true : undefined,
          },
        );
      }
    };

    const firstRaw = await callModel(buildProposalPrompt(prompt));
    let attempt = await this.tryApply(worktree, firstRaw);

    if (!attempt.ok) {
      const repairRaw = await callModel(buildRepairPrompt(prompt, attempt.malformedReason, attempt.detail, firstRaw));
      attempt = await this.tryApply(worktree, repairRaw);

      if (!attempt.ok) {
        const tracePath = await writeAgenticTrace(worktree, {
          model,
          malformedReason: attempt.malformedReason,
          detail: attempt.detail,
          rawResponseSummary: summarizeRawResponse(repairRaw),
        });
        const reason = attempt.malformedReason === 'invalid_json' ? 'error' : attempt.malformedReason;
        throw new HarnessError(
          `ollama-agentic malformed output (${attempt.malformedReason}); trace written to ${tracePath}`,
          reason,
          { exitCode: 0 },
        );
      }
    }

    const { proposal, raw } = attempt;

    try {
      await this.execFn(proposal.verifyCommand, {
        cwd: worktree,
        timeoutMs: Math.min(timeoutSeconds * 1000, 120_000),
        maxBuffer: 1024 * 1024,
        env,
        onPgid,
      });
    } catch (err: any) {
      const tracePath = await writeAgenticTrace(worktree, {
        model,
        malformedReason: 'verify_failed',
        detail: err.message ?? 'verification failed',
        rawResponseSummary: summarizeRawResponse(raw),
      });
      throw new HarnessError(
        `ollama-agentic verify failed (${proposal.verifyCommand}); trace written to ${tracePath}`,
        'verify_failed',
        { stderr: err.stderr },
      );
    }

    const output = [
      `APPLIED: ${proposal.changes.map((change) => change.file).join(', ')}`,
      `VERIFIED: ${proposal.verifyCommand}`,
      `SUMMARY: ${proposal.summary}`,
    ].join('\n');
    return { output };
  }

  private async tryApply(worktree: string, raw: string): Promise<ApplyResult> {
    const parsed = parseProposal(raw);
    if (!parsed.ok) return parsed;

    const prepared = await prepareChanges(worktree, parsed.proposal.changes);
    if (!prepared.ok) {
      return { ok: false, malformedReason: 'apply_failed', detail: prepared.detail };
    }

    await applyChanges(prepared.changes);
    return { ok: true, proposal: parsed.proposal, raw };
  }
}

const VERIFY_COMMAND_PROMPT_HINT = `"verifyCommand" must be one cheap check that proves the change worked and must start with one of: ${ALLOWED_VERIFY_COMMAND_PREFIXES.join(', ')}. No shell metacharacters, pipes, redirection, or absolute paths.`;

const FIND_REPLACE_PROMPT_HINT = `Each entry in "changes" is applied as an exact-match find/replace inside "file" (a path relative to the repo root); "find" must match exactly one location in the file, so include enough surrounding context to make it unique.
Use "find": "" to create a new file whose full content is "replace".`;

function buildProposalPrompt(taskPrompt: string): string {
  return `${taskPrompt}

Respond with exactly one JSON object matching the schema, no markdown, no prose.
${FIND_REPLACE_PROMPT_HINT}
${VERIFY_COMMAND_PROMPT_HINT}`;
}

function buildRepairPrompt(taskPrompt: string, malformedReason: MalformedReason, detail: string, raw: string): string {
  return `${taskPrompt}

Your previous response was malformed: ${malformedReason} (${detail}).
Raw response summary: ${summarizeRawResponse(raw)}

Respond with exactly one JSON object matching the schema, no markdown, no prose.
${FIND_REPLACE_PROMPT_HINT}
${VERIFY_COMMAND_PROMPT_HINT}`;
}

function parseProposal(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, malformedReason: 'empty_response', detail: 'model returned empty output' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(trimmed));
  } catch (err: any) {
    return { ok: false, malformedReason: 'invalid_json', detail: err.message ?? 'invalid JSON' };
  }

  return validateProposalSchema(parsed);
}

function stripJsonFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : text;
}

function validateProposalSchema(value: unknown): ParseResult {
  if (!isRecord(value)) {
    return { ok: false, malformedReason: 'schema_invalid', detail: 'proposal must be an object' };
  }
  if (typeof value.summary !== 'string' || value.summary.trim() === '') {
    return { ok: false, malformedReason: 'schema_invalid', detail: 'summary is required' };
  }
  if (typeof value.verifyCommand !== 'string' || value.verifyCommand.trim() === '') {
    return { ok: false, malformedReason: 'schema_invalid', detail: 'verifyCommand is required' };
  }
  const verifyCommand = value.verifyCommand.trim();
  const verifyCheck = validateVerifyCommand(verifyCommand);
  if (!verifyCheck.ok) {
    return { ok: false, malformedReason: 'schema_invalid', detail: verifyCheck.detail };
  }
  if (!Array.isArray(value.changes) || value.changes.length === 0) {
    return { ok: false, malformedReason: 'schema_invalid', detail: 'changes must be a non-empty array' };
  }
  if (value.changes.length > MAX_CHANGES) {
    return { ok: false, malformedReason: 'schema_invalid', detail: `changes exceed the maximum of ${MAX_CHANGES}` };
  }

  const seenFiles = new Set<string>();
  const changes: OllamaAgenticChange[] = [];
  for (const change of value.changes) {
    if (!isRecord(change)) {
      return { ok: false, malformedReason: 'schema_invalid', detail: 'each change must be an object' };
    }
    if (typeof change.file !== 'string' || change.file.trim() === '') {
      return { ok: false, malformedReason: 'schema_invalid', detail: 'each change requires a file' };
    }
    if (typeof change.find !== 'string') {
      return { ok: false, malformedReason: 'schema_invalid', detail: `${change.file}: find must be a string` };
    }
    if (typeof change.replace !== 'string') {
      return { ok: false, malformedReason: 'schema_invalid', detail: `${change.file}: replace must be a string` };
    }
    if (!isSafeRelativeFile(change.file)) {
      return { ok: false, malformedReason: 'schema_invalid', detail: `${change.file}: unsafe path` };
    }
    if (seenFiles.has(change.file)) {
      return {
        ok: false,
        malformedReason: 'schema_invalid',
        detail: `${change.file}: duplicate file entries are not supported`,
      };
    }
    seenFiles.add(change.file);
    changes.push({ file: change.file, find: change.find, replace: change.replace });
  }

  return {
    ok: true,
    proposal: {
      summary: value.summary.trim(),
      changes,
      verifyCommand,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeRelativeFile(file: string): boolean {
  if (isAbsolute(file)) return false;
  const normalized = relative('.', file);
  return normalized !== '' && normalized !== '..' && !normalized.startsWith(`..${sep}`);
}

interface PreparedChange {
  change: OllamaAgenticChange;
  path: string;
  content?: string;
  create: boolean;
}

async function prepareChanges(
  worktree: string,
  changes: OllamaAgenticChange[],
): Promise<{ ok: true; changes: PreparedChange[] } | { ok: false; detail: string }> {
  const prepared: PreparedChange[] = [];
  for (const change of changes) {
    const path = resolve(worktree, change.file);
    if (change.find === '') {
      const existing = await readFile(path, 'utf-8').catch(() => undefined);
      if (existing !== undefined) {
        return { ok: false, detail: `${change.file}: create target already exists` };
      }
      prepared.push({ change, path, create: true });
    } else {
      const content = await readFile(path, 'utf-8').catch(() => undefined);
      if (content === undefined) {
        return { ok: false, detail: `${change.file}: file could not be read` };
      }
      if (!content.includes(change.find)) {
        return { ok: false, detail: `${change.file}: find text was not present` };
      }
      const secondMatch = content.indexOf(change.find, content.indexOf(change.find) + 1);
      if (secondMatch !== -1) {
        return {
          ok: false,
          detail: `${change.file}: find text is ambiguous (matches more than one location); provide a longer find string that matches exactly once`,
        };
      }
      prepared.push({ change, path, content, create: false });
    }
  }
  return { ok: true, changes: prepared };
}

async function applyChanges(prepared: PreparedChange[]): Promise<void> {
  for (const { change, path, content, create } of prepared) {
    if (create) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, change.replace);
    } else {
      await writeFile(path, content!.replace(change.find, change.replace));
    }
  }
}

async function writeAgenticTrace(
  worktree: string,
  trace: { model: string; malformedReason: string; detail: string; rawResponseSummary: string },
): Promise<string> {
  const traceDir = join(worktree, '.factory', 'local-agent-traces');
  await mkdir(traceDir, { recursive: true });
  const tracePath = join(traceDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await writeFile(
    tracePath,
    `${JSON.stringify(
      {
        harness: 'ollama-agentic',
        model: trace.model,
        attempts: 2,
        malformedReason: trace.malformedReason,
        detail: trace.detail,
        rawResponseSummary: trace.rawResponseSummary,
      },
      null,
      2,
    )}\n`,
  );
  return tracePath;
}

function summarizeRawResponse(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '<empty>';
  return trimmed.replace(/\s+/g, ' ').slice(0, 500);
}
