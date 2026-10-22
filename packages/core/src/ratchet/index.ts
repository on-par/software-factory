// packages/core/src/ratchet/index.ts — daily ratchet trigger (#3542): one exception-list entry per firing becomes one queued issue.

import type { FactoryConfig } from '../config/index.js';
import type { EventKind } from '../events/kinds.js';

export interface RatchetListConfig {
  /** Slug used in the marker and the issue title. */
  name: string;
  /** Repo-relative path of the exception list (one entry per line). */
  file: string;
  /** Shell command that must pass once the entry is gone. */
  check: string;
}

export const RATCHET_LABEL = 'factory:ratchet';

export interface RatchetGitHub {
  /** Open issues labelled factory:ratchet whose body carries the list's marker. */
  openRatchetIssues(listName: string): Promise<number[]>;
  fileIssue(input: { title: string; body: string; labels: string[] }): Promise<number>;
  enqueue(lane: string, issue: number): Promise<{ ok: boolean; detail?: string }>;
}

export interface RatchetTriggerResult {
  filed?: { list: string; entry: string; issue: number };
  done: string[];
  skipped: { list: string; issues: number[] }[];
  errors: string[];
}

export function resolveRatchetConfig(config: FactoryConfig): { lists: RatchetListConfig[]; lane: string } {
  return { lists: config.ratchet?.lists ?? [], lane: config.ratchet?.lane ?? 'auto' };
}

export function parseExceptionList(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

export function ratchetMarker(listName: string): string {
  return `<!-- factory:ratchet list:${listName} -->`;
}

export function renderRatchetIssueBody(list: RatchetListConfig, entry: string): string {
  return [
    ratchetMarker(list.name),
    '',
    `Ratchet task for the \`${list.name}\` exception list (#3542).`,
    '',
    `- Remove exactly the line \`${entry}\` from \`${list.file}\`.`,
    `- Change the code so that \`${list.check}\` passes.`,
    '- Do not add entries to any exception list, loosen thresholds, or add suppressions.',
    '- This PR needs human review; it is never auto-merged.',
    '',
    '## Acceptance criteria',
    '',
    '```gherkin',
    `Given the entry \`${entry}\` is removed from \`${list.file}\``,
    `When \`${list.check}\` runs`,
    'Then it exits 0',
    '```',
    '',
  ].join('\n');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runRatchetTrigger(input: {
  lists: readonly RatchetListConfig[];
  lane: string;
  gateLabel: string;
  readList: (file: string) => string | null;
  github: RatchetGitHub;
  log: (type: EventKind, subject: string, message: string) => void;
}): Promise<RatchetTriggerResult> {
  const { lists, lane, gateLabel, readList, github, log } = input;
  const result: RatchetTriggerResult = { done: [], skipped: [], errors: [] };
  const fail = (subject: string, message: string): void => {
    log('warn', subject, message);
    result.errors.push(message);
  };

  for (const list of lists) {
    const content = readList(list.file);
    if (content === null) {
      fail(list.name, `ratchet list '${list.name}': cannot read ${list.file}`);
      continue;
    }
    let open: number[];
    try {
      open = await github.openRatchetIssues(list.name);
    } catch (err) {
      fail(list.name, `ratchet list '${list.name}': open-issue lookup failed: ${errMessage(err)}`);
      continue;
    }
    if (open.length > 0) {
      log(
        'ratchet-skipped',
        list.name,
        `ratchet list '${list.name}' skipped: open ratchet issue(s) ${open.map((n) => `#${n}`).join(', ')}`,
      );
      result.skipped.push({ list: list.name, issues: open });
      continue;
    }
    const entries = parseExceptionList(content);
    if (entries.length === 0) {
      log('ratchet-done', list.name, `ratchet list '${list.name}' is empty (${list.file})`);
      result.done.push(list.name);
      continue;
    }
    if (result.filed) continue;

    const entry = entries[0];
    try {
      const issue = await github.fileIssue({
        title: `ratchet(${list.name}): remove ${entry}`,
        body: renderRatchetIssueBody(list, entry),
        labels: [RATCHET_LABEL, gateLabel],
      });
      result.filed = { list: list.name, entry, issue };
      const queued = await github.enqueue(lane, issue);
      if (!queued.ok) {
        log('warn', list.name, `ratchet issue #${issue} was not queued on lane ${lane}: ${queued.detail ?? 'unknown'}`);
      }
      log('ratchet-filed', list.name, `ratchet list '${list.name}': filed #${issue} to remove '${entry}'`);
    } catch (err) {
      fail(list.name, `ratchet list '${list.name}': filing failed: ${errMessage(err)}`);
    }
  }
  return result;
}
