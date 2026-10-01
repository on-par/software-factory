// packages/core/src/config/example.ts — Render docs/config.example.yaml
//
// The example documents what a repo can write in `.factory/config.yaml` (JSON is still read), generated from the
// two schemas the runtime actually loads that file with: RepoFactoryConfigV2Schema (the
// model-routing namespace, ./repo.ts) and FactoryConfigSchema (the runtime-policy namespace,
// ./index.ts). Docs come from the model schema's `.describe()` text and the packaged
// defaults' `comment` fields; values come from the packaged defaults and the resolvers, so
// the file cannot drift from the code (example.test.ts fails when the committed copy is stale).
//
// Keys whose explicit value would outrank a FACTORY_* env var (every model-routing key, and
// run.merge) are rendered commented out, so the example as parsed YAML behaves exactly
// like having no config file at all.

import { z } from 'zod';

import { isPlainObject, loadFactoryConfig, loadModelsConfig, type FactoryConfig } from './index.js';
import { DEFAULT_REVIEW_FLOOR_RULES } from '../review/floor.js';
import { RepoFactoryConfigV2Schema, resolveEfficiencyPolicy, resolveUsageCap, resolveWatchdogPolicy } from './repo.js';

/** Top-level keys the loaders accept that the example deliberately leaves out, with why.
 *  example.test.ts fails when a newly accepted key is neither rendered nor listed here. */
export const CONFIG_EXAMPLE_OMITTED_KEYS: Readonly<Record<string, string>> = {
  $schema: 'accepted and ignored',
  policy: 'written by `factory migrate`; not read at runtime',
  merge: 'legacy spelling of run.merge; run.merge wins when both are set',
  adr: 'accepted; not read at runtime',
  byok: 'accepted; not read at runtime',
  cost_tracking: 'accepted; not read at runtime',
  discovery: 'accepted; not read at runtime',
  notifications: 'accepted; not read at runtime',
};

type Node =
  | { kind: 'object'; key: string; doc?: string; children: Node[] }
  | { kind: 'value'; key: string; doc?: string; value: unknown }
  | { kind: 'unset'; key: string; doc?: string; example: string };

const WRAP = 100;

/** Docs for runtime-policy sections whose packaged defaults carry no `comment`. */
const RUNTIME_NOTES: Record<string, string> = {
  timeouts:
    'Phase timeouts in seconds. FACTORY_PLAN_TIMEOUT, FACTORY_BUILD_TIMEOUT, FACTORY_CHECK_TIMEOUT and ' +
    'FACTORY_APPROVAL_TIMEOUT beat these values.',
  environment: 'Per-lane runtime environment.',
  'environment.processGroups': "Grace period in ms between SIGTERM and SIGKILL when a lane's process group is swept.",
  workspace:
    'Lane workspace. mode: "worktree" (default: git worktree on the host, contained by sandbox.runtime) or "docker" (fresh disposable clone per issue in a container; sandbox.runtime is ignored). FACTORY_WORKSPACE_MODE applies when mode is unset. backend: "host" or "disposable-docker" (a managed container per lane).',
};

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function inline(value: unknown): string {
  return Array.isArray(value) ? `[${value.map((v) => inline(v)).join(', ')}]` : JSON.stringify(value);
}

/** A map key, bare when it is a plain YAML word and JSON-quoted otherwise. */
function key(k: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) ? k : JSON.stringify(k);
}

/** Whether a node, or anything under it, is written as a live (uncommented) line. */
function hasLive(node: Node): boolean {
  if (node.kind === 'object') return node.children.some(hasLive);
  return node.kind === 'value';
}

function renderNodes(nodes: Node[], indent: number): string[] {
  return nodes.flatMap((node) => renderNode(node, indent));
}

/** `commented` comments out a live line because everything around it is unset. */
function renderNode(node: Node, indent: number, commented = false): string[] {
  const pad = ' '.repeat(indent);
  const doc = node.doc ? wrap(node.doc, WRAP - indent - 2).map((l) => `${pad}# ${l}`) : [];
  const name = key(node.key);
  if (node.kind === 'unset') return [...doc, `${pad}# ${name}: ${node.example}`];
  if (node.kind === 'value') return [...doc, `${pad}${commented ? '# ' : ''}${name}: ${inline(node.value)}`];
  // A map with no live key is commented out too: `pins:` alone would parse as null, which the schema rejects.
  const off = commented || !hasLive(node);
  return [
    ...doc,
    `${pad}${off ? '# ' : ''}${name}:`,
    ...node.children.flatMap((child) => renderNode(child, indent + 2, off)),
  ];
}

/** A packaged-default value as live nodes; a nested `comment` string becomes that level's doc. */
function fromDefaults(key: string, value: unknown, path = key): Node {
  if (!isPlainObject(value)) return { kind: 'value', key, value };
  const doc = typeof value.comment === 'string' ? value.comment : RUNTIME_NOTES[path];
  const children = Object.entries(value)
    .filter(([k]) => k !== 'comment')
    .map(([k, v]) => fromDefaults(k, v, `${path}.${k}`));
  return { kind: 'object', key, doc, children };
}

interface SchemaNode {
  description?: string;
  properties?: Record<string, SchemaNode>;
}

/** RepoFactoryConfigV2Schema as JSON Schema: its `properties` tree carries every `.describe()`. */
function modelConfigJsonSchema(): SchemaNode {
  return z.toJSONSchema(RepoFactoryConfigV2Schema, { io: 'input' }) as SchemaNode;
}

/** The schema node at a property path, e.g. field(root, 'budget', 'watchdog'). */
function field(root: SchemaNode, ...path: string[]): SchemaNode {
  return path.reduce<SchemaNode>((node, key) => node.properties?.[key] ?? {}, root);
}

function modelNamespace(): Node[] {
  const root = modelConfigJsonSchema();
  const doc = (...path: string[]) => field(root, ...path).description;
  const efficiency = resolveEfficiencyPolicy(null);
  const usage = resolveWatchdogPolicy(null, {});
  const packagedTiers = loadModelsConfig().tiers;

  // A string example is raw text (a placeholder such as "<model id>"); anything else is a default value.
  const unset = (key: string, description: string | undefined, example: unknown): Node => ({
    kind: 'unset',
    key,
    doc: description,
    example: typeof example === 'string' ? example : inline(example),
  });
  const leaves = (path: string[], example: unknown): Node[] =>
    Object.entries(field(root, ...path).properties ?? {}).map(([k, s]) => unset(k, s.description, example));

  return [
    {
      kind: 'object',
      key: 'models',
      children: [
        unset('efforts', doc('models', 'efforts'), '{ "<model id>": "<effort>" }'),
        {
          kind: 'object',
          key: 'pins',
          doc: doc('models', 'pins'),
          children: leaves(['models', 'pins'], '"<model id>"'),
        },
      ],
    },
    {
      kind: 'object',
      key: 'tiers',
      doc: doc('tiers'),
      children: Object.entries(packagedTiers).map(([tier, ids]) => unset(tier, undefined, ids)),
    },
    { kind: 'object', key: 'providers', doc: doc('providers'), children: leaves(['providers'], true) },
    unset('route', doc('route'), '"<route>"'),
    {
      kind: 'object',
      key: 'budget',
      children: [
        unset('capUsd', doc('budget', 'capUsd'), resolveUsageCap(null, {}).cap),
        unset('perIssueCapUsd', doc('budget', 'perIssueCapUsd'), '<usd>'),
        unset('fastPath', doc('budget', 'fastPath'), efficiency.fastPath),
        unset('maxReworkRounds', doc('budget', 'maxReworkRounds'), efficiency.maxReworkRounds),
        {
          kind: 'object',
          key: 'watchdog',
          doc: doc('budget', 'watchdog'),
          children: [
            unset('stopAt', doc('budget', 'watchdog', 'stopAt'), usage.stopAt),
            unset('resumeAt', doc('budget', 'watchdog', 'resumeAt'), usage.resumeAt),
            unset('pollSeconds', doc('budget', 'watchdog', 'pollSeconds'), usage.pollMs / 1000),
            unset('watch', doc('budget', 'watchdog', 'watch'), usage.watch),
            unset('estimator', doc('budget', 'watchdog', 'estimator'), usage.estimator),
          ],
        },
      ],
    },
    {
      kind: 'object',
      key: 'classifier',
      doc: doc('classifier'),
      children: [
        unset('alwaysHuman', doc('classifier', 'alwaysHuman'), '["<path prefix or glob>"]'),
        unset('autoEligible', doc('classifier', 'autoEligible'), '["<path prefix or glob>"]'),
        unset('maxDiffLines', doc('classifier', 'maxDiffLines'), DEFAULT_REVIEW_FLOOR_RULES.maxLines),
      ],
    },
  ];
}

function runtimeNamespace(): Node[] {
  const defaults = loadFactoryConfig();
  const section = (key: keyof FactoryConfig): Node => fromDefaults(key, defaults[key]);

  const sweep = section('sweep');
  if (sweep.kind === 'object') sweep.children.unshift({ kind: 'unset', key: 'heartbeatFile', example: '"<path>"' });

  return [
    {
      kind: 'object',
      key: 'run',
      doc:
        'Merge policy. `factory run` and `supervise` read `auto`; `factory land` reads `admin`. ' +
        '`factory ship` and `run-issue` always stop at a ready-for-review PR.',
      children: [
        {
          kind: 'object',
          key: 'merge',
          children: [
            {
              kind: 'unset',
              key: 'auto',
              doc: 'Squash-merge eligible PRs. Unset: legacy merge.auto, then FACTORY_MERGE=1. --auto-merge / --no-auto-merge beat all.',
              example: 'false',
            },
            {
              kind: 'unset',
              key: 'admin',
              doc: 'Merge with GitHub admin bypass of unmet requirements. Unset: FACTORY_MERGE_ADMIN=1.',
              example: 'false',
            },
          ],
        },
      ],
    },
    section('timeouts'),
    section('plan_approval'),
    section('ci'),
    section('worktree'),
    section('workspace'),
    section('sandbox'),
    section('environment'),
    section('auto_failover'),
    section('ingest'),
    section('filing'),
    section('kpis'),
    sweep,
    {
      kind: 'object',
      key: 'paths',
      doc: 'Only paths.constitution is read: the repo-relative path of the product constitution.',
      children: [{ kind: 'value', key: 'constitution', value: defaults.paths.constitution }],
    },
  ];
}

const HEADER = [
  'Reference for .factory/config.yaml. Generated by `npm run config-example` from the config',
  'schemas and packaged defaults. Do not edit by hand.',
  '',
  '.factory/config.yaml is preferred; .factory/config.yml and .factory/config.json are still',
  'read (keep only one). `factory migrate --to-yaml` converts a JSON config. Copy only the keys you',
  'want to change: copying this whole file pins today’s defaults, so later default changes',
  'would not reach your repo. A minimal config is `version: 2`.',
  '',
  'Commented-out keys are unset by default. Setting one outranks the matching FACTORY_* env',
  'var, so leave it out to keep env control. The value shown is the default, or a <placeholder>',
  'when there is none. `factory status --kpis` prints the effective config.',
  '',
  'Accepted but not shown:',
];

/** The full text of docs/config.example.yaml. Pure and deterministic. */
export function renderConfigExample(): string {
  const omitted = Object.entries(CONFIG_EXAMPLE_OMITTED_KEYS).map(([key, why]) => `  ${key} — ${why}.`);
  const header = [...HEADER, ...omitted, '  paths.* other than paths.constitution — accepted; not read at runtime.'];
  const body = renderNodes(
    [{ kind: 'value', key: 'version', value: 2 }, ...modelNamespace(), ...runtimeNamespace()],
    0,
  );
  return [...header.map((l) => (l ? `# ${l}` : '#')), ...body, ''].join('\n');
}
