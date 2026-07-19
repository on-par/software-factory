// src/steering/index.ts — Operator steering: queue mid-run guidance from the TUI,
// drain it at worker prompt-assembly boundaries (.factory/steering/)

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export interface SteeringMessage {
  id: string;
  issue: number;
  text: string;
  queuedAt: string; // ISO
}

export interface SteeringAttachment {
  path: string;
  content: string;
  truncated: boolean;
}

export interface ConsumedSteering {
  messages: SteeringMessage[];
  attachments: SteeringAttachment[];
}

export const MAX_ATTACHMENT_BYTES = 50_000;

const PATH_CANDIDATE_RE = /(?:^|[\s"'`([])([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+)/g;

export function steeringFileFor(dir: string, issue: number): string {
  return join(dir, `issue-${issue}.ndjson`);
}

export function queueSteeringMessage(dir: string, issue: number, text: string): SteeringMessage {
  mkdirSync(dir, { recursive: true });
  const message: SteeringMessage = {
    id: randomUUID(),
    issue,
    text,
    queuedAt: new Date().toISOString(),
  };
  appendFileSync(steeringFileFor(dir, issue), `${JSON.stringify(message)}\n`);
  return message;
}

/** Queued messages for `issue`, oldest first. Missing file → []. Malformed lines skipped. */
export function listQueuedSteering(dir: string, issue: number): SteeringMessage[] {
  const file = steeringFileFor(dir, issue);
  if (!existsSync(file)) return [];

  const messages: SteeringMessage[] = [];
  const lines = readFileSync(file, 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line) as SteeringMessage);
    } catch {
      // skip malformed line
    }
  }
  return messages;
}

/** Path-like tokens embedded in free text (repo-relative, no traversal, no leading slash). */
export function extractPathCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(PATH_CANDIDATE_RE)) {
    const candidate = match[1];
    // The capture group can't itself start with '/' (see PATH_CANDIDATE_RE), so
    // only the '..' traversal guard is reachable here — kept explicit for safety.
    if (candidate.split('/').includes('..')) continue;
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * Read-and-drain the queue for `issue`: atomically rename the queue file aside
 * (so a concurrent TUI append starts a fresh queue file), parse it, delete the
 * temp file, then resolve any file-path attachments referenced in the messages.
 * Missing file → empty result.
 */
export function drainSteering(dir: string, issue: number, worktree: string): ConsumedSteering {
  const file = steeringFileFor(dir, issue);
  const draining = `${file}.draining`;

  try {
    renameSync(file, draining);
  } catch {
    return { messages: [], attachments: [] };
  }

  const messages: SteeringMessage[] = [];
  const lines = readFileSync(draining, 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line) as SteeringMessage);
    } catch {
      // skip malformed line
    }
  }
  unlinkSync(draining);

  const attachments: SteeringAttachment[] = [];
  const seenPaths = new Set<string>();
  const worktreePrefix = worktree.endsWith(sep) ? worktree : `${worktree}${sep}`;

  for (const message of messages) {
    for (const candidate of extractPathCandidates(message.text)) {
      if (seenPaths.has(candidate)) continue;
      const resolved = resolve(worktree, candidate);
      if (!resolved.startsWith(worktreePrefix)) continue;

      let stat;
      try {
        stat = statSync(resolved);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      seenPaths.add(candidate);
      const raw = readFileSync(resolved, 'utf-8');
      const truncated = raw.length > MAX_ATTACHMENT_BYTES;
      attachments.push({
        path: candidate,
        content: truncated ? raw.slice(0, MAX_ATTACHMENT_BYTES) : raw,
        truncated,
      });
    }
  }

  return { messages, attachments };
}

/** Append operator guidance to `prompt`. Returns `prompt` unchanged (same string) when there's nothing to apply. */
export function applySteering(prompt: string, steering?: ConsumedSteering): string {
  if (!steering || steering.messages.length === 0) return prompt;

  const bullets = steering.messages.map((m) => `- [${m.queuedAt}] ${m.text}`).join('\n');

  let block = `\n\n## Operator guidance (steering)
The human operator watching this run sent the following mid-run guidance.
It supplements the frozen spec — follow it unless it conflicts with the constitution.

${bullets}`;

  if (steering.attachments.length > 0) {
    const files = steering.attachments
      .map((a) => `#### ${a.path}${a.truncated ? ' (truncated)' : ''}\n\`\`\`\n${a.content}\n\`\`\``)
      .join('\n\n');
    block += `\n\n### Attached files\n${files}`;
  }

  return prompt + block;
}

/** One-line record of what a drain consumed, for the `steering_applied` event. */
export function describeSteering(steering: ConsumedSteering): string {
  const ids = steering.messages.map((m) => m.id).join(', ');
  const attached = steering.attachments.length > 0 ? steering.attachments.map((a) => a.path).join(', ') : 'none';
  return `applied ${steering.messages.length} steering message(s) [${ids}]; attached: ${attached}`;
}
