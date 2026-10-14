// packages/cli/src/cli/doctor-config.test.ts — config and registry row tests, moved from doctor.test.ts (#2799)

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConstitutionLoader } from '@on-par/factory-core';
import { type ConfigLintInput, lintFactoryConfig } from '@on-par/factory-core/internal';
import { afterEach, describe, expect, it } from 'vitest';

import { doctorFailed, formatDoctorChecks, REPO_SECTION } from './doctor.js';
import { configLintChecks, declaredHarnessChecks, modelsRegistryChecks } from './doctor-config.js';

describe('declaredHarnessChecks', () => {
  it('reports a passing probe as an ok check', () => {
    const [check] = declaredHarnessChecks([
      { harness: 'my-agent', probe: 'my-agent --version', status: 'available', detail: '' },
    ]);
    expect(check).toEqual({ name: 'harness my-agent', ok: true, detail: 'available (probe: my-agent --version)' });
  });

  it('reports a failing probe as a non-optional failed check with the failure and a fix', () => {
    const checks = declaredHarnessChecks([
      { harness: 'my-agent', probe: 'my-agent --version', status: 'unavailable', detail: 'exit 127: not found' },
    ]);
    expect(checks[0]).toMatchObject({
      name: 'harness my-agent',
      ok: false,
      detail: 'unavailable: probe `my-agent --version` failed: exit 127: not found',
    });
    expect(checks[0].optional).toBeUndefined();
    expect(checks[0].fix).toContain('probe');
    expect(doctorFailed(checks)).toBe(true);
  });

  it('reports a harness without a probe as an optional unverified check', () => {
    const checks = declaredHarnessChecks([{ harness: 'my-agent', status: 'unverified', detail: '' }]);
    expect(checks[0]).toMatchObject({
      name: 'harness my-agent',
      ok: false,
      optional: true,
      detail: 'unverified: no probe configured',
    });
    expect(checks[0].fix).toContain('probe');
    expect(doctorFailed(checks)).toBe(false);
  });

  it('returns no checks for no declared harnesses', () => {
    expect(declaredHarnessChecks([])).toEqual([]);
  });
});

describe('modelsRegistryChecks', () => {
  const cfg = '/repo/.factory/config.json';
  const valid = ['opencode', 'claude-cli', 'my-agent'];

  it('returns nothing for an undefined or empty registry', () => {
    expect(modelsRegistryChecks(cfg, undefined, valid)).toEqual([]);
    expect(modelsRegistryChecks(cfg, {}, valid)).toEqual([]);
  });

  it('fails an entry with no harness, naming the path and field', () => {
    const rows = modelsRegistryChecks(cfg, { 'my-model': {} }, valid);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.optional).toBeUndefined();
    expect(rows[0]?.detail).toContain(cfg);
    expect(rows[0]?.detail).toContain('models.registry.my-model.harness');
    expect(doctorFailed(rows)).toBe(true);
  });

  it('treats a whitespace-only harness as missing', () => {
    const rows = modelsRegistryChecks(cfg, { 'my-model': { harness: '   ' } }, valid);
    expect(rows[0]?.detail).toContain('is missing');
  });

  it('fails an unknown harness, naming the path, field, value and valid list', () => {
    const rows = modelsRegistryChecks(cfg, { 'my-model': { harness: 'nope' } }, valid);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain(cfg);
    expect(rows[0]?.detail).toContain('models.registry.my-model.harness');
    expect(rows[0]?.detail).toContain("'nope'");
    expect(rows[0]?.detail).toContain('opencode, claude-cli, my-agent');
    expect(doctorFailed(rows)).toBe(true);
  });

  it('treats an exact-case mismatch as unknown', () => {
    expect(modelsRegistryChecks(cfg, { m: { harness: 'Opencode' } }, valid)[0]?.ok).toBe(false);
  });

  it('accepts a harness that is only declared', () => {
    const rows = modelsRegistryChecks(cfg, { m: { harness: 'my-agent' } }, valid);
    expect(rows.every((r) => r.ok)).toBe(true);
  });

  it('reports one ok row and no failure when every entry has a known harness', () => {
    const rows = modelsRegistryChecks(cfg, { a: { harness: 'opencode' }, b: { harness: 'claude-cli' } }, valid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'models.registry', ok: true });
    expect(rows[0]?.detail).toContain('2 entries valid');
    expect(doctorFailed(rows)).toBe(false);
  });

  it('uses the singular for one valid entry', () => {
    expect(modelsRegistryChecks(cfg, { a: { harness: 'opencode' } }, valid)[0]?.detail).toContain('1 entry valid');
  });

  it('gives one failed row per invalid entry and no ok row for a mixed registry', () => {
    const rows = modelsRegistryChecks(cfg, { a: { harness: 'opencode' }, b: {}, c: { harness: 'nope' } }, valid);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.ok)).toBe(false);
  });
});

describe('configLintChecks (#2610, #2612)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const PLACEHOLDER_CONSTITUTION =
    '---\nproduct: acme\nversion: 1\ncheckers:\n  - <checker-name>\n  - compile\n---\nbody\n';
  const VALID_CONSTITUTION = PLACEHOLDER_CONSTITUTION.replace('<checker-name>', 'compile');
  const VALID_CONFIG = 'sweep:\n  enabled: false\n';

  function setup(constitution: string, config: string): ConfigLintInput {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-config-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.factory'));
    writeFileSync(join(dir, '.factory', 'constitution.md'), constitution);
    const y = join(dir, '.factory', 'config.yaml');
    writeFileSync(y, config);
    return {
      constitution: new ConstitutionLoader().loadRepoConstitution(dir),
      configFile: { absPath: y, relPath: '.factory/config.yaml' },
    };
  }

  it('flags a placeholder checker with file:line and the fix', () => {
    const rows = configLintChecks(setup(PLACEHOLDER_CONSTITUTION, VALID_CONFIG));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'config', ok: false, section: REPO_SECTION });
    expect(rows[0].optional).toBeUndefined();
    expect(rows[0].detail).toContain('.factory/constitution.md:5');
    expect(rows[0].detail).toContain('placeholder checker');
    expect(rows[0].detail).toContain('<checker-name>');
    expect(rows[0].fix).toContain('compile');
    expect(rows[0].fix).toContain('custom_*');
    expect(doctorFailed(rows)).toBe(true);
    const out = formatDoctorChecks(rows);
    expect(out).toContain('❌ config - .factory/constitution.md:5');
    expect(out).toContain('fix:');
  });

  it("flags unknown checker 'typecheck' at its line", () => {
    const rows = configLintChecks(setup(PLACEHOLDER_CONSTITUTION.replace('<checker-name>', 'typecheck'), VALID_CONFIG));
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].detail).toBe(".factory/constitution.md:5: unknown checker 'typecheck'");
    expect(rows[0].fix).toContain('custom_*');
  });

  it('passes when the constitution and config.yaml have no placeholders', () => {
    const rows = configLintChecks(setup(VALID_CONSTITUTION, VALID_CONFIG));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'config', ok: true });
    expect(rows[0].detail).toContain('.factory/constitution.md');
    expect(rows[0].detail).toContain('.factory/config.yaml');
    expect(doctorFailed(rows)).toBe(false);
  });

  it('reports an unfilled token in config.yaml with the generic fix', () => {
    const rows = configLintChecks(setup(VALID_CONSTITUTION, 'version: 2\nmodels:\n  pins:\n    build: <model id>\n'));
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].detail).toBe(".factory/config.yaml:4: unfilled template token '<model id>'");
    expect(rows[0].fix).toBe("replace '<model id>' with a real value");
  });

  it('flags a config.yaml schema error with file:line and the fix', () => {
    const rows = configLintChecks(setup(VALID_CONSTITUTION, 'sweep:\n  loopIntervalSeconds: soon\n'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'config', ok: false, section: REPO_SECTION });
    expect(rows[0].optional).toBeUndefined();
    expect(rows[0].detail).toMatch(/^\.factory\/config\.yaml:2: schema error at 'sweep\.loopIntervalSeconds'/);
    expect(rows[0].fix).toContain('sweep.loopIntervalSeconds');
    expect(doctorFailed(rows)).toBe(true);
    const out = formatDoctorChecks(rows);
    expect(out).toContain('❌ config - .factory/config.yaml:2');
    expect(out).toContain('fix:');
  });

  it('reports an unknown checker and a config.yaml schema error, each with file:line and the fix', () => {
    const rows = configLintChecks(
      setup(PLACEHOLDER_CONSTITUTION.replace('<checker-name>', 'typecheck'), 'sweep:\n  loopIntervalSeconds: soon\n'),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.ok)).toBe(true);
    expect(rows[0].detail).toBe(".factory/constitution.md:5: unknown checker 'typecheck'");
    expect(rows[0].fix).toContain('custom_*');
    expect(rows[1].detail).toContain('.factory/config.yaml:2');
    expect(rows[1].fix).toBeTruthy();
  });

  it('passes with a neutral detail when neither file exists', () => {
    const rows = configLintChecks({
      constitution: null,
      configFile: { absPath: '/nonexistent/b.yaml', relPath: 'b.yaml' },
    });
    expect(rows).toEqual([
      { name: 'config', ok: true, section: REPO_SECTION, detail: 'no constitution or config file to scan' },
    ]);
  });

  it('returns a single failing row when the constitution could not be parsed', () => {
    const rows = configLintChecks({ constitution: null }, 'cannot parse constitution: bad yaml');
    expect(rows).toEqual([
      {
        name: 'config',
        ok: false,
        section: REPO_SECTION,
        detail: 'cannot parse constitution: bad yaml',
        fix: 'fix the constitution frontmatter YAML',
      },
    ]);
  });

  it('leaves the constitution and config file byte-identical', () => {
    const input = setup(PLACEHOLDER_CONSTITUTION, 'version: 2\nmodels:\n  pins:\n    build: <model id>\n');
    const paths = [input.constitution?.repoInstance?.absPath as string, input.configFile?.absPath as string];
    const snap = () => paths.map((p) => [readFileSync(p, 'utf-8'), statSync(p).mtimeMs]);
    const before = snap();
    configLintChecks(input);
    expect(snap()).toEqual(before);
  });
});

describe('config lint parity with the run preflight (#2612)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const fm = (checkers: string, body = 'body') =>
    `---\nproduct: acme\nversion: 1\ncheckers:${checkers}\n---\n${body}\n`;
  const CLEAN_CONFIG = 'sweep:\n  enabled: false\n';
  const fixtures: { name: string; constitution: string | null; config: string; verdict: 'ok' | 'escalate' | 'park' }[] =
    [
      { name: 'clean', constitution: fm('\n  - compile'), config: CLEAN_CONFIG, verdict: 'ok' },
      {
        name: 'placeholder checker',
        constitution: fm('\n  - <checker-name>'),
        config: CLEAN_CONFIG,
        verdict: 'escalate',
      },
      {
        name: 'unknown checker typecheck',
        constitution: fm('\n  - typecheck'),
        config: CLEAN_CONFIG,
        verdict: 'escalate',
      },
      { name: 'custom_foo checker', constitution: fm('\n  - custom_foo'), config: CLEAN_CONFIG, verdict: 'ok' },
      {
        name: 'frontmatter token',
        constitution: '---\nproduct: <product name>\nversion: 1\ncheckers:\n  - compile\n---\nbody\n',
        config: CLEAN_CONFIG,
        verdict: 'park',
      },
      {
        name: 'token only in body',
        constitution: fm('\n  - compile', 'see <thing>'),
        config: CLEAN_CONFIG,
        verdict: 'ok',
      },
      {
        name: 'config.yaml token',
        constitution: fm('\n  - compile'),
        config: 'version: 2\nmodels:\n  pins:\n    build: <model id>\n',
        verdict: 'park',
      },
      {
        name: 'commented-out token',
        constitution: fm('\n  - compile'),
        config: '# build: <model id>\nsweep:\n  enabled: false\n',
        verdict: 'ok',
      },
      {
        name: 'flow-list unknown checker',
        constitution: fm(' [compile, bogus]'),
        config: CLEAN_CONFIG,
        verdict: 'escalate',
      },
      {
        name: 'unknown checker plus config token',
        constitution: fm('\n  - typecheck'),
        config: 'version: 2\nmodels:\n  pins:\n    build: <model id>\n',
        verdict: 'escalate',
      },
      { name: 'no constitution file', constitution: null, config: CLEAN_CONFIG, verdict: 'ok' },
    ];

  // Schema errors are doctor-only by design (#2611), so they are not in this parity table.
  it.each(fixtures)('doctor and preflight agree on $name', ({ constitution, config, verdict }) => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-parity-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.factory'));
    if (constitution !== null) writeFileSync(join(dir, '.factory', 'constitution.md'), constitution);
    const y = join(dir, '.factory', 'config.yaml');
    writeFileSync(y, config);
    const input: ConfigLintInput = {
      constitution: new ConstitutionLoader().loadRepoConstitution(dir),
      configFile: { absPath: y, relPath: '.factory/config.yaml' },
    };
    const preflight = lintFactoryConfig(input).verdict !== 'ok';
    const doctor = doctorFailed(configLintChecks(input));
    expect(doctor).toBe(preflight);
    expect(lintFactoryConfig(input).verdict).toBe(verdict);
  });
});
