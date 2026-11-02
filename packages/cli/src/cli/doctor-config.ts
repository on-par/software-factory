// packages/cli/src/cli/doctor-config.ts — config and registry rows, moved out of doctor.ts (#2799)

import { existsSync } from 'node:fs';

import type { DeclaredHarnessProbe } from '@on-par/factory-core';
import type { ConfigLintInput } from '@on-par/factory-core/internal';
import {
  findConfigSchemaErrors,
  findCodexSandboxWarnings,
  findUnknownConfigKeyWarnings,
  isTemplateToken,
  lintFactoryConfig,
  listBuiltInCheckers,
} from '@on-par/factory-core/internal';

import { type DoctorCheck, REPO_SECTION } from './doctor.js';

/** One doctor check per user-declared harness, from its `probe` result. */
export function declaredHarnessChecks(probes: DeclaredHarnessProbe[]): DoctorCheck[] {
  return probes.map((p): DoctorCheck => {
    const name = `harness ${p.harness}`;
    if (p.status === 'available') return { name, ok: true, detail: `available (probe: ${p.probe})` };
    if (p.status === 'unavailable') {
      return {
        name,
        ok: false,
        detail: `unavailable: probe \`${p.probe}\` failed: ${p.detail}`,
        fix: 'install the agent CLI on PATH or fix the "probe" command in the models config harnesses section',
      };
    }
    return {
      name,
      ok: false,
      optional: true,
      detail: 'unverified: no probe configured',
      fix: 'add a "probe" command (exit 0 = reachable) to the harness in the models config',
    };
  });
}

const REGISTRY_CHECK = 'models.registry';

/** One failed check per models.registry entry whose harness is missing or unknown;
 *  a single ok row when every entry is valid; nothing when there is no registry. */
export function modelsRegistryChecks(
  configPath: string,
  registry: Readonly<Record<string, { harness?: string }>> | undefined,
  validHarnesses: readonly string[],
): DoctorCheck[] {
  const entries = Object.entries(registry ?? {});
  if (entries.length === 0) return [];
  const failed: DoctorCheck[] = [];
  for (const [id, def] of entries) {
    const field = `models.registry.${id}.harness`;
    const name = `${REGISTRY_CHECK} ${id}`;
    if (def.harness === undefined || def.harness.trim() === '') {
      failed.push({
        name,
        ok: false,
        detail: `${configPath}: ${field} is missing`,
        fix: `set "harness" to one of: ${validHarnesses.join(', ')}`,
      });
    } else if (!validHarnesses.includes(def.harness)) {
      failed.push({
        name,
        ok: false,
        detail: `${configPath}: ${field} '${def.harness}' is not a known harness (valid harnesses: ${validHarnesses.join(', ')})`,
        fix: 'use a built-in harness id or declare it under "harnesses" in the models config',
      });
    }
  }
  if (failed.length > 0) return failed;
  const n = entries.length;
  return [{ name: REGISTRY_CHECK, ok: true, detail: `${n} entr${n === 1 ? 'y' : 'ies'} valid (${configPath})` }];
}

/** `config` rows from the shared pre-PLAN lint (#2612): one failing row per finding, so doctor fails exactly when
 *  the run preflight would escalate or park. A single ok row when clean. Read-only. */
export function configLintChecks(input: ConfigLintInput, loadError?: string): DoctorCheck[] {
  return [...configLintRows(input, loadError), ...unknownKeyRows(input), ...codexSandboxRows(input)];
}

/** Non-failing ⚠️ rows, one per nested config key this version ignores (#3568, ADR-0160 warn stage). */
function unknownKeyRows(input: ConfigLintInput): DoctorCheck[] {
  return (input.configFile ? findUnknownConfigKeyWarnings(input.configFile) : []).map((f): DoctorCheck => ({
    name: 'config',
    ok: false,
    optional: true,
    section: REPO_SECTION,
    detail: `${f.file}${f.line ? `:${f.line}` : ''}: ${f.message}`,
    fix: f.fix,
  }));
}

/** Non-failing ⚠️ row for an unknown sandbox.codexSandbox value, ignored by this version (#3829, ADR-0160 warn stage). */
function codexSandboxRows(input: ConfigLintInput): DoctorCheck[] {
  return (input.configFile ? findCodexSandboxWarnings(input.configFile) : []).map((f): DoctorCheck => ({
    name: 'config',
    ok: false,
    optional: true,
    section: REPO_SECTION,
    detail: `${f.file}${f.line ? `:${f.line}` : ''}: ${f.message}`,
    fix: f.fix,
  }));
}

function configLintRows(input: ConfigLintInput, loadError?: string): DoctorCheck[] {
  const schemaRows = (input.configFile ? findConfigSchemaErrors(input.configFile) : []).map((f): DoctorCheck => ({
    name: 'config',
    ok: false,
    section: REPO_SECTION,
    detail: `${f.file}${f.line ? `:${f.line}` : ''}: schema error at '${f.path}': ${f.message}`,
    fix: f.fix,
  }));
  if (loadError !== undefined) {
    return [
      {
        name: 'config',
        ok: false,
        section: REPO_SECTION,
        detail: loadError,
        fix: 'fix the constitution frontmatter YAML',
      },
      ...schemaRows,
    ];
  }
  const { findings } = lintFactoryConfig(input);
  if (findings.length > 0) {
    const names = [...listBuiltInCheckers().map((c) => c.name), 'custom_*'].join(', ');
    const lintRows = findings.map((f): DoctorCheck => {
      const where = `${f.file}${f.line ? `:${f.line}` : ''}`;
      if (f.rule === 'unknown-checker') {
        const kind = isTemplateToken(f.token) ? 'placeholder' : 'unknown';
        return {
          name: 'config',
          ok: false,
          section: REPO_SECTION,
          detail: `${where}: ${kind} checker '${f.token}'`,
          fix: `replace '${f.token}' with a real checker name (${names}) or delete the line`,
        };
      }
      return {
        name: 'config',
        ok: false,
        section: REPO_SECTION,
        detail: `${where}: unfilled template token '${f.token}'`,
        fix: `replace '${f.token}' with a real value`,
      };
    });
    return [...lintRows, ...schemaRows];
  }
  if (schemaRows.length > 0) return schemaRows;
  const scanned: string[] = [];
  if (input.constitution?.repoInstance) scanned.push(input.constitution.repoInstance.relPath);
  if (input.configFile && existsSync(input.configFile.absPath)) scanned.push(input.configFile.relPath);
  return [
    {
      name: 'config',
      ok: true,
      section: REPO_SECTION,
      detail:
        scanned.length > 0
          ? `no unfilled placeholders, unknown checkers or schema errors in ${scanned.join(', ')}`
          : 'no constitution or config file to scan',
    },
  ];
}
