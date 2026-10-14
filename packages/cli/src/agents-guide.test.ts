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
const STATUSES = new Set(['supported', 'experimental', 'planned']);
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
  let inFence = false;
  while (end < lines.length) {
    if ((lines[end] ?? '').startsWith('```')) inFence = !inFence;
    const m = inFence ? null : /^(#{1,6})\s+/.exec(lines[end] ?? '');
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

function withRepoConfig<T>(yaml: string, prefix: string, fn: (repo: ReturnType<typeof loadRepoConfig>) => T): T {
  const savedRunConfig = process.env.FACTORY_RUN_CONFIG_JSON;
  delete process.env.FACTORY_RUN_CONFIG_JSON;
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    mkdirSync(join(dir, '.factory'));
    writeFileSync(join(dir, '.factory', 'config.yaml'), yaml);
    return fn(loadRepoConfig(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (savedRunConfig === undefined) delete process.env.FACTORY_RUN_CONFIG_JSON;
    else process.env.FACTORY_RUN_CONFIG_JSON = savedRunConfig;
  }
}

function byoProblems(section: string): string[] {
  const parts: Array<[string, boolean]> = [
    ['harnesses:', section.includes('harnesses:')],
    ['factory doctor', section.includes('factory doctor')],
    ['factory harness check', section.includes('factory harness check')],
    ['factory run', section.includes('factory run')],
    ['output: jsonl-last-message', section.includes('output: jsonl-last-message')],
    ['a link to harness-contract.md', /\]\([^)]*harness-contract\.md[^)]*\)/.test(section)],
    [
      'an issue template link (issues/new/choose or issues/new?template=<file> that exists)',
      section.includes('issues/new/choose') ||
        [...section.matchAll(/issues\/new\?template=([^)\s&]+)/g)].some((m) =>
          existsSync(join(repoRoot, '.github', 'ISSUE_TEMPLATE', m[1] ?? '')),
        ),
    ],
  ];
  return parts.filter(([, ok]) => !ok).map(([what]) => `Bring your own agent section is missing ${what}`);
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

  it('names a Bring your own agent section missing the harness check step', () => {
    const section = [
      'harnesses:',
      'factory doctor',
      'factory run',
      'output: jsonl-last-message',
      '[contract](harness-contract.md)',
      'https://github.com/on-par/software-factory/issues/new/choose',
    ].join('\n');
    expect(byoProblems(section)).toEqual(['Bring your own agent section is missing factory harness check']);
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
      if (!STATUSES.has(status)) problems.push(`row ${id} has invalid status "${status}"`);
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
    for (const recipe of RECIPES) {
      const yaml = yamlBlocks(recipeSection(lines, recipe) ?? '')[0];
      if (yaml === undefined) {
        problems.push(`${recipe}: no yaml block`);
        continue;
      }
      try {
        withRepoConfig(yaml, 'agents-recipe-', (repo) => {
          if (repo?.version !== 2) {
            problems.push(`${recipe}: expected a version 2 config`);
            return;
          }
          const applied = applyRepoConfig(loadModelsConfig(), repo);
          for (const id of Object.values(repo.models?.pins ?? {}))
            if (typeof id === 'string' && !(id in applied.models)) problems.push(`${recipe} pins unknown model ${id}`);
        });
      } catch (err) {
        problems.push(`${recipe}: ${err instanceof Error ? err.message : String(err)}`);
      }
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

  it('Bring your own agent section names every step and links harness-contract.md, and relative links resolve', () => {
    const text = guideText ?? '';
    const lines = text.split('\n');
    const start = headingIndex(lines, (h) => h === 'bring your own agent');
    const problems: string[] = [];
    if (start < 0) problems.push('no Bring your own agent section');
    else problems.push(...byoProblems(sectionAt(lines, start)));
    if (headingIndex(lines, (h) => h === 'add your own agent') >= 0)
      problems.push('stale Add your own agent section remains');
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1] ?? '';
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const path = target.split('#')[0] ?? '';
      if (!existsSync(resolve(dirname(guidePath), path))) problems.push(`broken relative link ${target}`);
    }
    expect(problems).toEqual([]);
  });

  it('Bring your own agent yaml loads as a .factory/config.yaml, declares a harness and pins plan, build and checker to known models', () => {
    const lines = (guideText ?? '').split('\n');
    const start = headingIndex(lines, (h) => h === 'bring your own agent');
    const blocks = start < 0 ? [] : yamlBlocks(sectionAt(lines, start));
    const problems: string[] = [];
    if (blocks.length !== 1)
      problems.push(`Bring your own agent must have exactly one yaml block, found ${blocks.length}`);
    else {
      try {
        withRepoConfig(blocks[0] ?? '', 'agents-byo-', (repo) => {
          if (repo?.version !== 2) problems.push('expected a version 2 config');
          const declared = Object.keys(repo?.harnesses ?? {});
          if (declared.length === 0) problems.push('declares no harness under harnesses');
          const applied = applyRepoConfig(loadModelsConfig(), repo);
          for (const id of declared) if (!(id in (applied.harnesses ?? {}))) problems.push(`harness ${id} not applied`);
          for (const pin of ['plan', 'build', 'checker']) {
            const model = repo?.models?.pins?.[pin as 'plan'];
            if (typeof model !== 'string') problems.push(`no ${pin} pin`);
            else if (!(model in applied.models)) problems.push(`${pin} pins unknown model ${model}`);
          }
        });
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }
    expect(problems).toEqual([]);
  });

  it('matrix command row Phases cell names build_command and agentic true', () => {
    const lines = (guideText ?? '').split('\n');
    const start = lines.findIndex((l) => l.trim().startsWith('|') && cellsOf(l).some((c) => /^harness id$/i.test(c)));
    const table: string[] = [];
    for (let i = start; start >= 0 && i < lines.length && (lines[i] ?? '').trim().startsWith('|'); i++)
      table.push(lines[i] ?? '');
    const header = cellsOf(table[0] ?? '');
    const idCol = header.findIndex((c) => /^harness id$/i.test(c));
    const phasesCol = header.findIndex((c) => /^phases$/i.test(c));
    const row = table
      .slice(1)
      .map(cellsOf)
      .find((cells) => (cells[idCol] ?? '').replace(/`/g, '').trim() === 'command');
    const cell = row?.[phasesCol] ?? '';
    const problems: string[] = [];
    if (!cell.includes('build_command')) problems.push('command Phases cell does not name build_command');
    if (!cell.includes('agentic: true')) problems.push('command Phases cell does not say agentic: true');
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
