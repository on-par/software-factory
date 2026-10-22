// src/queue/prerequisite-order.ts — order an unpark batch prerequisite-first (#3330).

import { findDeclaredPrerequisites } from '../blockers/declared-prerequisites.js';
import type { BlockedByItem } from '../blockers/dependencies.js';

export type PrerequisiteOrderResult = { ok: true; order: number[] } | { ok: false; cycle: number[] };

export interface BatchPrerequisiteReaders {
  repo: string; // 'owner/name' — blocked_by items from other repos are ignored
  readIssueBody(issue: number): Promise<string>;
  listBlockedBy(issue: number): Promise<BlockedByItem[]>;
}

export type BatchPrerequisitesResult =
  { ok: true; prereqsOf: Map<number, number[]> } | { ok: false; issue: number; error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findCycle(batch: readonly number[], remaining: ReadonlySet<number>, deps: Map<number, number[]>): number[] {
  const visited = new Set<number>();
  const stack: number[] = [];
  const onStack = new Set<number>();

  const visit = (node: number): number[] | undefined => {
    if (onStack.has(node)) {
      return [...stack.slice(stack.indexOf(node)), node];
    }
    if (visited.has(node)) {
      return undefined;
    }
    visited.add(node);
    stack.push(node);
    onStack.add(node);
    for (const dep of deps.get(node) ?? []) {
      if (remaining.has(dep)) {
        const found = visit(dep);
        if (found) {
          return found;
        }
      }
    }
    stack.pop();
    onStack.delete(node);
    return undefined;
  };

  for (const start of batch) {
    if (remaining.has(start)) {
      const found = visit(start);
      if (found) {
        return found;
      }
    }
  }
  return [];
}

/**
 * Stable topological sort: every in-batch prerequisite precedes the issues that
 * need it; ties keep the given order. Out-of-batch prerequisites are ignored.
 * A cycle yields the cycle (first issue repeated) instead of an order.
 */
export function orderByPrerequisites(
  issues: readonly number[],
  prereqsOf: ReadonlyMap<number, readonly number[]>,
): PrerequisiteOrderResult {
  const batch = [...new Set(issues)];
  const inBatch = new Set(batch);
  const deps = new Map<number, number[]>(
    batch.map((n) => [n, [...new Set((prereqsOf.get(n) ?? []).filter((p) => inBatch.has(p)))]]),
  );

  const remaining = new Set(batch);
  const emitted = new Set<number>();
  const order: number[] = [];
  for (;;) {
    const next = batch.find((n) => remaining.has(n) && (deps.get(n) ?? []).every((p) => emitted.has(p)));
    if (next === undefined) {
      break;
    }
    order.push(next);
    remaining.delete(next);
    emitted.add(next);
  }

  if (remaining.size === 0) {
    return { ok: true, order };
  }
  return { ok: false, cycle: findCycle(batch, remaining, deps) };
}

/** Build the prerequisite map for a batch from declared `Prerequisite: #N` lines and open same-repo native blocked_by items. */
export async function collectBatchPrerequisites(
  issues: readonly number[],
  readers: BatchPrerequisiteReaders,
): Promise<BatchPrerequisitesResult> {
  const prereqsOf = new Map<number, number[]>();
  const repo = readers.repo.toLowerCase();
  for (const n of new Set(issues)) {
    let body: string;
    try {
      body = await readers.readIssueBody(n);
    } catch (error) {
      return { ok: false, issue: n, error: `#${n}: could not read issue body: ${errorMessage(error)}` };
    }
    let items: BlockedByItem[];
    try {
      items = await readers.listBlockedBy(n);
    } catch (error) {
      return { ok: false, issue: n, error: `#${n}: could not list blocked_by: ${errorMessage(error)}` };
    }
    const blocked = items.filter((i) => i.state === 'open' && i.repository.toLowerCase() === repo).map((i) => i.number);
    prereqsOf.set(n, [...new Set([...findDeclaredPrerequisites(body), ...blocked])]);
  }
  return { ok: true, prereqsOf };
}
