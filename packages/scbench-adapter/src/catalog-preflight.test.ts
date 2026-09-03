import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCatalogPreflight, type CatalogPreflightSpec } from './catalog-preflight.js';

const ADAPTER_CLI = '/pkg/dist/cli.js';
const CATALOG = '/catalog';
const PROBLEM_IDS = ['cfgpipe', 'circuit_eval', 'code_search'];

function fakeExists(present: Iterable<string>): (path: string) => boolean {
  const set = new Set(present);
  return (path) => set.has(path);
}

function configPath(id: string): string {
  return join(CATALOG, id, 'config.yaml');
}

describe('runCatalogPreflight', () => {
  it('passes with every subject ok and confirms all problem ids in order', () => {
    const spec: CatalogPreflightSpec = { adapterCli: ADAPTER_CLI, catalogPath: CATALOG, problemIds: PROBLEM_IDS };
    const exists = fakeExists([ADAPTER_CLI, CATALOG, ...PROBLEM_IDS.map(configPath)]);

    const outcome = runCatalogPreflight(spec, { exists });

    expect(outcome.ok).toBe(true);
    expect(outcome.results.every((r) => r.ok)).toBe(true);
    expect(outcome.confirmedProblemIds).toEqual(PROBLEM_IDS);
  });

  it('fails when the adapter build output is missing, without short-circuiting the other subjects', () => {
    const spec: CatalogPreflightSpec = { adapterCli: ADAPTER_CLI, catalogPath: CATALOG, problemIds: PROBLEM_IDS };
    const exists = fakeExists([CATALOG, ...PROBLEM_IDS.map(configPath)]);

    const outcome = runCatalogPreflight(spec, { exists });

    expect(outcome.ok).toBe(false);
    const buildResult = outcome.results.find((r) => r.subject === 'adapter build');
    expect(buildResult?.ok).toBe(false);
    expect(buildResult?.detail).toContain(ADAPTER_CLI);
    const catalogResult = outcome.results.find((r) => r.subject === 'SCBENCH_PROBLEMS_PATH');
    expect(catalogResult?.ok).toBe(true);
    expect(outcome.results.filter((r) => r.subject.startsWith('problem '))).toHaveLength(PROBLEM_IDS.length);
  });

  it('fails with "is not set" and skips per-problem checks when catalogPath is undefined', () => {
    const spec: CatalogPreflightSpec = { adapterCli: ADAPTER_CLI, catalogPath: undefined, problemIds: PROBLEM_IDS };
    const exists = fakeExists([ADAPTER_CLI, ...PROBLEM_IDS.map(configPath)]);

    const outcome = runCatalogPreflight(spec, { exists });

    expect(outcome.ok).toBe(false);
    const catalogResult = outcome.results.find((r) => r.subject === 'SCBENCH_PROBLEMS_PATH');
    expect(catalogResult).toEqual({ subject: 'SCBENCH_PROBLEMS_PATH', ok: false, detail: 'is not set' });
    expect(outcome.results.some((r) => r.subject.startsWith('problem '))).toBe(false);
    expect(outcome.confirmedProblemIds).toEqual([]);
  });

  it('fails with "is not set" when catalogPath is an empty string', () => {
    const spec: CatalogPreflightSpec = { adapterCli: ADAPTER_CLI, catalogPath: '', problemIds: PROBLEM_IDS };
    const exists = fakeExists([ADAPTER_CLI]);

    const outcome = runCatalogPreflight(spec, { exists });

    expect(outcome.ok).toBe(false);
    expect(outcome.results.find((r) => r.subject === 'SCBENCH_PROBLEMS_PATH')?.detail).toBe('is not set');
  });

  it('fails naming the path and skips per-problem checks when the catalog path does not exist', () => {
    const spec: CatalogPreflightSpec = { adapterCli: ADAPTER_CLI, catalogPath: CATALOG, problemIds: PROBLEM_IDS };
    const exists = fakeExists([ADAPTER_CLI]);

    const outcome = runCatalogPreflight(spec, { exists });

    expect(outcome.ok).toBe(false);
    const catalogResult = outcome.results.find((r) => r.subject === 'SCBENCH_PROBLEMS_PATH');
    expect(catalogResult?.ok).toBe(false);
    expect(catalogResult?.detail).toContain(CATALOG);
    expect(outcome.results.some((r) => r.subject.startsWith('problem '))).toBe(false);
    expect(outcome.confirmedProblemIds).toEqual([]);
  });

  it('fails on one unknown problem id while still confirming the valid ones', () => {
    const spec: CatalogPreflightSpec = {
      adapterCli: ADAPTER_CLI,
      catalogPath: CATALOG,
      problemIds: ['cfgpipe', 'not_a_real_problem', 'code_search'],
    };
    const exists = fakeExists([ADAPTER_CLI, CATALOG, configPath('cfgpipe'), configPath('code_search')]);

    const outcome = runCatalogPreflight(spec, { exists });

    expect(outcome.ok).toBe(false);
    const failing = outcome.results.find((r) => r.subject === 'problem not_a_real_problem');
    expect(failing?.ok).toBe(false);
    expect(failing?.detail).toContain('not_a_real_problem');
    expect(failing?.detail).toContain(configPath('not_a_real_problem'));
    expect(outcome.confirmedProblemIds).toEqual(['cfgpipe', 'code_search']);
  });

  it('uses existsSync by default when deps.exists is omitted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-preflight-'));
    try {
      const missingCli = join(dir, 'nonexistent', 'cli.js');
      const spec: CatalogPreflightSpec = { adapterCli: missingCli, catalogPath: undefined, problemIds: [] };

      const outcome = runCatalogPreflight(spec);

      expect(outcome.ok).toBe(false);
      expect(outcome.results.find((r) => r.subject === 'adapter build')?.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runCatalogPreflight (tmpdir round-trip)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'catalog-preflight-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves real problem directories through the default exists dep', () => {
    const cli = join(dir, 'dist', 'cli.js');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(cli, '');
    const catalog = join(dir, 'catalog');
    mkdirSync(join(catalog, 'cfgpipe'), { recursive: true });
    writeFileSync(join(catalog, 'cfgpipe', 'config.yaml'), '');

    const outcome = runCatalogPreflight({ adapterCli: cli, catalogPath: catalog, problemIds: ['cfgpipe'] });

    expect(outcome.ok).toBe(true);
    expect(outcome.confirmedProblemIds).toEqual(['cfgpipe']);
  });
});
