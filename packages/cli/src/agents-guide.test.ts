import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRepoConfig, KNOWN_HARNESS_IDS, loadModelsConfig, loadRepoConfig } from '@on-par/factory-core';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GUIDE = 'docs/agents.md';
const PROVIDERS = ['Claude Code', 'Codex', 'OpenCode'] as const;
const RECIPES = ['Claude-only', 'Codex-only', 'OpenCode Go-only', 'Local Ollama', 'Mixed'] as const;
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

function sectionAt(lines: string[], start: number): string {
  const depth = (/^(#+)/.exec(lines[start] ?? '')?.[1] ?? '').length;
  let end = start + 1;
  while (end < lines.length) {
    const m = /^(#{1,6})\s+/.exec(lines[end] ?? '');
    if (m && (m[1] ?? '').length <= depth) break;
    end++;
  }
  return lines.slice(start, end).join('\n');
}

function headingIndex(lines: string[], matches: (heading: string) => boolean): number {
  return lines.findIndex((l) => {
    const m = /^(#{2,6})\s+(.*)$/.exec(l);
    return m !== null && matches((m[2] ?? '').toLowerCase().trim());
  });
}

function providerSection(lines: string[], provider: string): string | undefined {
  const name = provider.toLowerCase();
  const start = headingIndex(lines, (h) => h.startsWith(name));
  return start < 0 ? undefined : sectionAt(lines, start);
}

function recipeSection(lines: string[], recipe: string): string | undefined {
  const name = `recipe: ${recipe.toLowerCase()}`;
  const start = headingIndex(lines, (h) => h === name);
  return start < 0 ? undefined : sectionAt(lines, start);
}

const YAML_BLOCK = /```yaml\n([\s\S]*?)```/g;
const yamlBlocks = (section: string): string[] => [...section.matchAll(YAML_BLOCK)].map((m) => m[1] ?? '');
const versionTested = (section: string): string => /^Version tested:[ \t]*(.*)$/im.exec(section)?.[1]?.trim() ?? '';

function recipeProblems(text: string, name = GUIDE): string[] {
  const lines = text.split('\n');
  const problems: string[] = [];
  for (const recipe of RECIPES) {
    const section = recipeSection(lines, recipe);
    if (section === undefined) {
      problems.push(`${name} has no Recipe: ${recipe} section`);
      continue;
    }
    if (yamlBlocks(section).length !== 1) problems.push(`${name} Recipe: ${recipe} must have exactly one yaml block`);
    if (versionTested(section) === '') problems.push(`${name} Recipe: ${recipe} has no Version tested line`);
  }
  return problems;
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

function completeRecipes(drop?: { recipe: string; part: 'yaml' | 'version' }): string {
  const sections = RECIPES.map((r) =>
    [
      `### Recipe: ${r}`,
      '',
      ...(drop?.recipe === r && drop.part === 'yaml' ? [] : ['```yaml', 'version: 2', '```', '']),
      ...(drop?.recipe === r && drop.part === 'version' ? [] : ['Version tested: 1.0.0', '']),
    ].join('\n'),
  );
  return ['## Recipes', '', ...sections].join('\n');
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

  it('accepts a complete recipes block', () => {
    expect(recipeProblems(completeRecipes())).toEqual([]);
  });

  it('names a missing recipe', () => {
    const text = completeRecipes().replace('### Recipe: Mixed', '### Mixed');
    expect(recipeProblems(text)).toEqual(['docs/agents.md has no Recipe: Mixed section']);
  });

  it('names a recipe with no yaml block', () => {
    expect(recipeProblems(completeRecipes({ recipe: 'Codex-only', part: 'yaml' }))).toEqual([
      'docs/agents.md Recipe: Codex-only must have exactly one yaml block',
    ]);
  });

  it('names a recipe with no version line', () => {
    expect(recipeProblems(completeRecipes({ recipe: 'Local Ollama', part: 'version' }))).toEqual([
      'docs/agents.md Recipe: Local Ollama has no Version tested line',
    ]);
  });

  it('reports a guide with no harness matrix', () => {
    const stub = '# Coding agent setup\n\nThe per-provider sections are tracked in #2408.\n';
    expect(agentsGuideProblems(stub, KNOWN_HARNESS_IDS)).toContain(
      'docs/agents.md has no harness matrix (a table with a "Harness id" column)',
    );
  });
});

describe('docs/agents.md supported agents guide', () => {
  it('docs/agents.md exists', () => {
    expect(guideText === undefined ? [`${label} does not exist`] : []).toEqual([]);
  });

  it('has a matrix row for every catalog harness id and complete provider sections', () => {
    expect(agentsGuideProblems(guideText, KNOWN_HARNESS_IDS, label)).toEqual([]);
  });

  it('matrix has every column filled and a valid status in every row', () => {
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

  it('has all five recipes, each with one yaml block and a Version tested line', () => {
    expect(recipeProblems(guideText ?? '', label)).toEqual([]);
  });

  it('every recipe loads as a .factory/config.yaml and pins only known models, with versions matching the provider sections', () => {
    const lines = (guideText ?? '').split('\n');
    const problems: string[] = [];
    const savedRunConfig = process.env.FACTORY_RUN_CONFIG_JSON;
    delete process.env.FACTORY_RUN_CONFIG_JSON;
    try {
      for (const recipe of RECIPES) {
        const yaml = yamlBlocks(recipeSection(lines, recipe) ?? '')[0];
        if (yaml === undefined) {
          problems.push(`${recipe}: no yaml block`);
          continue;
        }
        const dir = mkdtempSync(join(tmpdir(), 'agents-recipe-'));
        try {
          mkdirSync(join(dir, '.factory'));
          writeFileSync(join(dir, '.factory', 'config.yaml'), yaml);
          const repo = loadRepoConfig(dir);
          if (repo?.version !== 2) {
            problems.push(`${recipe}: expected a version 2 config`);
            continue;
          }
          const applied = applyRepoConfig(loadModelsConfig(), repo);
          for (const id of Object.values(repo.models?.pins ?? {}))
            if (typeof id === 'string' && !(id in applied.models)) problems.push(`${recipe} pins unknown model ${id}`);
        } catch (err) {
          problems.push(`${recipe}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    } finally {
      if (savedRunConfig === undefined) delete process.env.FACTORY_RUN_CONFIG_JSON;
      else process.env.FACTORY_RUN_CONFIG_JSON = savedRunConfig;
    }
    const expectations: ReadonlyArray<[(typeof PROVIDERS)[number], (typeof RECIPES)[number][]]> = [
      ['Claude Code', ['Claude-only', 'Mixed']],
      ['Codex', ['Codex-only', 'Mixed']],
      ['OpenCode', ['OpenCode Go-only']],
    ];
    for (const [provider, recipes] of expectations) {
      const version = versionTested(providerSection(lines, provider) ?? '');
      if (version === '') problems.push(`${provider} section has no version tested value`);
      for (const recipe of recipes)
        if (!versionTested(recipeSection(lines, recipe) ?? '').includes(version))
          problems.push(`Recipe: ${recipe} version does not include ${provider} version "${version}"`);
    }
    expect(problems).toEqual([]);
  });

  it('add-your-own-agent section covers the command harness, contract doc, contract kit and issue template, and relative links resolve', () => {
    const text = guideText ?? '';
    const lines = text.split('\n');
    const start = headingIndex(lines, (h) => h === 'add your own agent');
    const problems: string[] = [];
    if (start < 0) {
      problems.push('no Add your own agent section');
    } else {
      const section = sectionAt(lines, start);
      const parts: Array<[string, boolean]> = [
        ['a harnesses declaration', section.includes('harnesses')],
        ['the command harness', section.includes('"command"') || section.includes('command:')],
        ['a link to harness-contract.md', /\]\([^)]*harness-contract\.md[^)]*\)/.test(section)],
        ['codingHarnessContractCases', section.includes('codingHarnessContractCases')],
        ['the contract kit command (npx vitest run)', section.includes('npx vitest run')],
        [
          'an issue template link (issues/new/choose or issues/new?template=<file> that exists)',
          section.includes('issues/new/choose') ||
            [...section.matchAll(/issues\/new\?template=([^)\s&]+)/g)].some((m) =>
              existsSync(join(repoRoot, '.github', 'ISSUE_TEMPLATE', m[1] ?? '')),
            ),
        ],
      ];
      for (const [what, ok] of parts) if (!ok) problems.push(`Add your own agent section is missing ${what}`);
    }
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1] ?? '';
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const path = target.split('#')[0] ?? '';
      if (!existsSync(resolve(dirname(guidePath), path))) problems.push(`broken relative link ${target}`);
    }
    expect(problems).toEqual([]);
  });

  it('Request support instead links the agent-support issue template, and the template exists', () => {
    const lines = (guideText ?? '').split('\n');
    const start = headingIndex(lines, (h) => h === 'request support instead');
    const section = start < 0 ? '' : sectionAt(lines, start);
    const problems: string[] = [];
    if (start < 0) problems.push('no Request support instead section');
    if (!section.includes('issues/new?template=agent-support.yml'))
      problems.push('Request support instead does not link issues/new?template=agent-support.yml');
    if (!/\]\([^)]*\.github\/ISSUE_TEMPLATE\/agent-support\.yml\)/.test(section))
      problems.push('Request support instead does not link .github/ISSUE_TEMPLATE/agent-support.yml');
    if (!existsSync(join(repoRoot, '.github', 'ISSUE_TEMPLATE', 'agent-support.yml')))
      problems.push('.github/ISSUE_TEMPLATE/agent-support.yml does not exist');
    expect(problems).toEqual([]);
  });
});
