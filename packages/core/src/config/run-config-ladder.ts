/** Per-run config ladder (#3906), highest first: FACTORY_CONFIG_OVERRIDES merged over the winner of
 *  --config / FACTORY_CONFIG_PATH / FACTORY_CONFIG_YAML / the repo file / packaged defaults. */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { parse as parseYaml, YAMLParseError } from 'yaml';

import { deepMergeConfig, factoryRuntimeConfigIssues, isPlainObject, type ConfigSchemaIssue } from './index.js';
import { readRepoConfigFile } from './repo-config-file.js';
import { repoRoutingConfigIssues } from './repo.js';

export type ConfigSourceLabel =
  | '--config'
  | 'FACTORY_CONFIG_PATH'
  | 'FACTORY_CONFIG_YAML'
  | 'repo'
  | 'packaged defaults'
  | '--constitution'
  | 'FACTORY_CONSTITUTION_PATH'
  | 'FACTORY_CONSTITUTION';

export interface RunConfigLadder {
  /** undefined only when neither a file nor an override exists. */
  raw: Record<string, unknown> | undefined;
  source: ConfigSourceLabel;
  /** File path for file sources (repo, --config, FACTORY_CONFIG_PATH); undefined for inline/defaults. */
  path?: string;
  /** Dotted key paths set by FACTORY_CONFIG_OVERRIDES, redacted; [] when unset. */
  overrideKeys: string[];
}

const blank = (v: string | undefined): v is undefined => v === undefined || v.trim() === '';

function parseInline(text: string, name: string): unknown {
  try {
    return parseYaml(text);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      throw new Error(`Failed to parse ${name} (line ${err.linePos?.[0]?.line ?? '?'}): ${err.message}`, {
        cause: err,
      });
    }
    throw err;
  }
}

function leafPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    isPlainObject(v) && Object.keys(v).length > 0 ? leafPaths(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

function redactKey(path: string): string {
  const last = path.split('.').pop() ?? path;
  return last.endsWith('Env') || /(token|secret|password|apikey|credential)/i.test(last) ? '<redacted key>' : path;
}

function formatIssues(issues: ConfigSchemaIssue[]): string {
  return issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

function schemaIssues(raw: Record<string, unknown>, version: unknown): ConfigSchemaIssue[] {
  return [...factoryRuntimeConfigIssues(raw), ...repoRoutingConfigIssues({ version: version ?? 2, ...raw })];
}

interface Winner {
  raw: unknown;
  source: ConfigSourceLabel;
  path?: string;
}

function pickWinner(configPath: string, env: NodeJS.ProcessEnv): Winner {
  const filePath = env.FACTORY_CONFIG_PATH;
  if (!blank(filePath)) {
    const source = env.FACTORY_CONFIG_PATH_SOURCE === '--config' ? '--config' : 'FACTORY_CONFIG_PATH';
    const raw = readRepoConfigFile(filePath);
    if (raw === undefined) throw new Error(`${source}: no config file at ${filePath}`);
    return { raw, source, path: filePath };
  }
  if (!blank(env.FACTORY_CONFIG_YAML)) {
    return { raw: parseInline(env.FACTORY_CONFIG_YAML, 'FACTORY_CONFIG_YAML'), source: 'FACTORY_CONFIG_YAML' };
  }
  const repo = readRepoConfigFile(configPath);
  if (repo !== undefined) return { raw: repo, source: 'repo', path: configPath };
  // Packaged defaults are the v2 shape. Without the stamp an overrides-only snapshot has no `version`, so every
  // loader read it as a legacy v1 file and warned that a .factory/config.yaml that does not exist is v1 (#4018).
  return { raw: { version: 2 }, source: 'packaged defaults' };
}

export function resolveRunConfigLadder(configPath: string, env: NodeJS.ProcessEnv = process.env): RunConfigLadder {
  const winner = pickWinner(configPath, env);
  if (!isPlainObject(winner.raw)) throw new Error(`Invalid ${winner.source}: expected a mapping`);
  const base = winner.raw;
  const { source, path } = winner;
  let raw: Record<string, unknown> = base;
  let overrideKeys: string[] = [];

  if (!blank(env.FACTORY_CONFIG_OVERRIDES)) {
    const fragment = parseInline(env.FACTORY_CONFIG_OVERRIDES, 'FACTORY_CONFIG_OVERRIDES');
    if (!isPlainObject(fragment)) throw new Error('Invalid FACTORY_CONFIG_OVERRIDES: expected a mapping');
    const fragmentIssues = schemaIssues(fragment, base.version);
    if (fragmentIssues.length > 0) throw new Error(`Invalid FACTORY_CONFIG_OVERRIDES: ${formatIssues(fragmentIssues)}`);
    raw = deepMergeConfig(base, fragment);
    overrideKeys = leafPaths(fragment).map(redactKey);
  }

  if (source !== 'repo' || overrideKeys.length > 0) {
    const issues = schemaIssues(raw, raw.version);
    if (issues.length > 0) throw new Error(`Invalid ${source}: ${formatIssues(issues)}`);
  }

  const empty = source === 'packaged defaults' && overrideKeys.length === 0;
  return { raw: empty ? undefined : raw, source, ...(path === undefined ? {} : { path }), overrideKeys };
}

export function resolveConstitutionOverride(
  env: NodeJS.ProcessEnv = process.env,
): { text: string; source: ConfigSourceLabel; path?: string } | undefined {
  const path = env.FACTORY_CONSTITUTION_PATH;
  if (!blank(path)) {
    const source =
      env.FACTORY_CONSTITUTION_PATH_SOURCE === '--constitution' ? '--constitution' : 'FACTORY_CONSTITUTION_PATH';
    if (!existsSync(path)) throw new Error(`${source}: no constitution file at ${path}`);
    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch (err) {
      throw new Error(`${source}: cannot read ${path}: ${(err as Error).message}`, { cause: err });
    }
    if (!text.trim()) throw new Error(`${source}: constitution file is empty: ${path}`);
    return { text, source, path };
  }
  const inline = env.FACTORY_CONSTITUTION;
  if (!blank(inline)) return { text: inline, source: 'FACTORY_CONSTITUTION' };
  return undefined;
}

export function describeConfigSources(config: RunConfigLadder, constitution: string): string {
  let label: string = config.source;
  if (config.source === 'repo') label = `.factory/${basename(config.path ?? 'config.yaml')}`;
  else if (config.path !== undefined) label = `${config.source} (${config.path})`;
  const changed = config.overrideKeys.length > 0 ? `; overrides changed: ${config.overrideKeys.join(', ')}` : '';
  return `config: ${label}; constitution: ${constitution}${changed}`;
}
