import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_HARNESS_IDS } from '@on-par/factory-core';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GUIDE = 'docs/agents.md';
const PROVIDERS = ['Claude Code', 'Codex', 'OpenCode'] as const;
const MATRIX_COLUMNS = [
  'Agent',
  'Harness id',
  'Install and auth',
  'Phases',
  'Sandbox',
  'Usage and cost',
  'Rate-limit classification',
  'CI coverage',
  'Status',
];
const STATUSES = ['supported', 'experimental', 'planned'];
const STEPS: ReadonlyArray<{ step: string; test: (s: string) => boolean }> = [
  { step: 'install', test: (s) => /\binstall/i.test(s) },
  { step: 'log in', test: (s) => /\blog\s?in\b|\bsign(ed)?\s?in\b/i.test(s) },
  { step: 'config', test: (s) => s.includes('.factory/config.yaml') },
  { step: 'doctor', test: (s) => s.includes('factory doctor') },
];

// The override lets the guard run against another copy of the guide.
const override = process.env.FACTORY_AGENTS_GUIDE_PATH;
const guidePath = override ? resolve(process.cwd(), override) : join(repoRoot, GUIDE);
const label = override || GUIDE;
const guideText = existsSync(guidePath) ? readFileSync(guidePath, 'utf8') : undefined;

const cellsOf = (line: string): string[] => {
  const cells = line
    .trim()
    .split('|')
    .map((c) => c.trim());
  if (cells[0] === '') cells.shift();
  if (cells[cells.length - 1] === '') cells.pop();
  return cells;
};

function matrixIds(lines: string[]): string[] | undefined {
  let i = 0;
  while (i < lines.length) {
    if (!(lines[i] ?? '').trim().startsWith('|')) {
      i++;
      continue;
    }
    const table: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) table.push(lines[i++] ?? '');
    const col = cellsOf(table[0] ?? '').findIndex((c) => /^harness id$/i.test(c));
    if (col < 0) continue;
    return table
      .slice(1)
      .map(cellsOf)
      .filter((cells) => !cells.every((c) => /^:?-+:?$/.test(c)))
      .map((cells) => (cells[col] ?? '').replace(/`/g, '').trim());
  }
  return undefined;
}

function providerSection(lines: string[], provider: string): string | undefined {
  const name = provider.toLowerCase();
  const start = lines.findIndex((l) => {
    const m = /^(#{2,6})\s+(.*)$/.exec(l);
    return m !== null && (m[2] ?? '').toLowerCase().trim().startsWith(name);
  });
  if (start < 0) return undefined;
  const depth = (/^(#+)/.exec(lines[start] ?? '')?.[1] ?? '').length;
  let end = start + 1;
  while (end < lines.length) {
    const m = /^(#{1,6})\s+/.exec(lines[end] ?? '');
    if (m && (m[1] ?? '').length <= depth) break;
    end++;
  }
  return lines.slice(start, end).join('\n');
}

function agentsGuideProblems(text: string | undefined, harnessIds: readonly string[], name = GUIDE): string[] {
  if (text === undefined) return [`${name} does not exist`];
  const problems: string[] = [];
  const lines = text.split('\n');
  const ids = matrixIds(lines);
  if (ids === undefined) {
    problems.push(`${name} has no harness matrix (a table with a "Harness id" column)`);
  } else {
    for (const id of harnessIds) if (!ids.includes(id)) problems.push(`${name} matrix has no row for harness id ${id}`);
  }
  for (const provider of PROVIDERS) {
    const section = providerSection(lines, provider);
    if (section === undefined) {
      problems.push(`${name} has no ${provider} section`);
      continue;
    }
    for (const { step, test } of STEPS)
      if (!test(section)) problems.push(`${name} ${provider} section has no ${step} step`);
  }
  return problems;
}

const providerBody = [
  'Install the CLI with your package manager.',
  'Log in with the vendor flow.',
  'Set the harness in `.factory/config.yaml`.',
  'Run `factory doctor` to verify.',
];

function completeGuide(ids: readonly string[], dropLine?: { provider: string; index: number }): string {
  const sections = PROVIDERS.map((p) => {
    const body = providerBody.filter((_, i) => !(dropLine?.provider === p && dropLine.index === i));
    return `## ${p}\n\n${body.join('\n')}\n`;
  });
  const rows = ids.map((id) => `| x | \`${id}\` | supported |`);
  return [
    '# Coding agent setup',
    '',
    '## Harness matrix',
    '',
    '| Agent | Harness id | Status |',
    '| ----- | ---------- | ------ |',
    ...rows,
    '',
    ...sections,
  ].join('\n');
}

describe('docs/agents.md guard self-test', () => {
  it('accepts a complete guide covering every catalog harness id', () => {
    expect(KNOWN_HARNESS_IDS.length).toBeGreaterThan(0);
    expect(agentsGuideProblems(completeGuide(KNOWN_HARNESS_IDS), KNOWN_HARNESS_IDS)).toEqual([]);
  });

  it('reports a missing guide by name', () => {
    expect(agentsGuideProblems(undefined, KNOWN_HARNESS_IDS)).toEqual(['docs/agents.md does not exist']);
  });

  it('names every catalog harness id with no matrix row', () => {
    const missing = KNOWN_HARNESS_IDS[KNOWN_HARNESS_IDS.length - 1] ?? '';
    const text = completeGuide(KNOWN_HARNESS_IDS.slice(0, -1));
    const expected = [`docs/agents.md matrix has no row for harness id ${missing}`];
    expect(agentsGuideProblems(text, KNOWN_HARNESS_IDS)).toEqual(expected);
    // An id mentioned only in prose does not count as a matrix row.
    expect(agentsGuideProblems(`${text}\n\nWe also support ${missing}.\n`, KNOWN_HARNESS_IDS)).toEqual(expected);
  });

  it('names the provider and the missing step', () => {
    expect(
      agentsGuideProblems(completeGuide(KNOWN_HARNESS_IDS, { provider: 'Codex', index: 3 }), KNOWN_HARNESS_IDS),
    ).toEqual(['docs/agents.md Codex section has no doctor step']);
    expect(
      agentsGuideProblems(completeGuide(KNOWN_HARNESS_IDS, { provider: 'OpenCode', index: 0 }), KNOWN_HARNESS_IDS),
    ).toEqual(['docs/agents.md OpenCode section has no install step']);
    const noClaude = completeGuide(KNOWN_HARNESS_IDS).replace(/## Claude Code[\s\S]*?(?=## Codex)/, '');
    expect(agentsGuideProblems(noClaude, KNOWN_HARNESS_IDS)).toEqual(['docs/agents.md has no Claude Code section']);
  });

  it('reports a guide with no harness matrix', () => {
    const stub = '# Coding agent setup\n\nThe per-provider sections are tracked in #2408.\n';
    expect(agentsGuideProblems(stub, KNOWN_HARNESS_IDS)).toContain(
      'docs/agents.md has no harness matrix (a table with a "Harness id" column)',
    );
  });
});

// The content guard arms itself once #2539 replaces the placeholder stub.
const isPlaceholder = guideText !== undefined && guideText.includes('The per-provider sections are tracked in #2408.');

describe('docs/agents.md supported agents guide', () => {
  it('docs/agents.md exists', () => {
    expect(guideText === undefined ? [`${label} does not exist`] : []).toEqual([]);
  });

  it.skipIf(isPlaceholder)('has a matrix row for every catalog harness id and complete provider sections', () => {
    expect(agentsGuideProblems(guideText, KNOWN_HARNESS_IDS, label)).toEqual([]);
  });

  it.skipIf(isPlaceholder)('matrix has every column filled and a valid status in every row', () => {
    const lines = (guideText ?? '').split('\n');
    const problems: string[] = [];
    const start = lines.findIndex((l) => l.trim().startsWith('|') && cellsOf(l).some((c) => /^harness id$/i.test(c)));
    const table: string[] = [];
    for (let i = start; start >= 0 && i < lines.length && (lines[i] ?? '').trim().startsWith('|'); i++)
      table.push(lines[i] ?? '');
    const header = cellsOf(table[0] ?? '');
    for (const col of MATRIX_COLUMNS)
      if (!header.some((c) => c.toLowerCase() === col.toLowerCase())) problems.push(`matrix has no ${col} column`);
    const statusCol = header.findIndex((c) => /^status$/i.test(c));
    for (const row of table.slice(1).map(cellsOf)) {
      if (row.every((c) => /^:?-+:?$/.test(c))) continue;
      const id = row[header.findIndex((c) => /^harness id$/i.test(c))] ?? row[0] ?? '?';
      if (row.length !== header.length) problems.push(`row ${id} has ${row.length} cells, expected ${header.length}`);
      if (row.some((c) => c === '')) problems.push(`row ${id} has an empty cell`);
      const status = (row[statusCol] ?? '').replace(/`/g, '').toLowerCase();
      if (!STATUSES.includes(status)) problems.push(`row ${id} has invalid status "${status}"`);
    }
    for (const provider of PROVIDERS) {
      const section = providerSection(lines, provider);
      if (section !== undefined && !/version tested/i.test(section))
        problems.push(`${provider} section has no version tested`);
    }
    expect(problems).toEqual([]);
  });
});
