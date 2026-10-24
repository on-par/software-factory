import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ContractFinding {
  command: string;
  path: string;
  oldType: string;
  newType: string;
  reason: string;
}

export interface ContractCheckIo {
  cwd?: string;
  git?: (args: readonly string[]) => string;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

type Schema = Record<string, unknown>;

function isRecord(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

function branches(node: Schema): Schema[] {
  const alternatives = node.anyOf;
  if (!Array.isArray(alternatives)) return [node];
  return alternatives.filter(isRecord);
}

function typeSet(node: Schema): string[] {
  const direct = node.type;
  const types = new Set<string>();
  if (typeof direct === 'string') types.add(direct);
  if (Array.isArray(direct)) for (const type of direct) if (typeof type === 'string') types.add(type);
  if (Array.isArray(node.anyOf)) {
    for (const branch of branches(node)) {
      if (branch.type === 'null') types.add('null');
      else for (const type of typeSet(branch)) types.add(type);
    }
  }
  return [...types].sort();
}

function typeLabel(node: Schema | undefined): string {
  if (!node) return '<removed>';
  const types = typeSet(node);
  return types.length ? types.join(' | ') : 'unconstrained';
}

function asSchema(value: unknown): Schema | undefined {
  return isRecord(value) ? value : undefined;
}

function validateSchema(value: unknown, label: string): Schema {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object schema`);
  const visit = (node: unknown, path: string): void => {
    if (!isRecord(node)) throw new Error(`${label} ${path} must be an object schema`);
    if (node.type !== undefined && typeof node.type !== 'string' && !Array.isArray(node.type)) {
      throw new Error(`${label} ${path}.type must be a string or array`);
    }
    if (Array.isArray(node.type) && !node.type.every((type) => typeof type === 'string')) {
      throw new Error(`${label} ${path}.type must contain only strings`);
    }
    if (node.properties !== undefined) {
      if (!isRecord(node.properties)) throw new Error(`${label} ${path}.properties must be an object`);
      for (const [key, child] of Object.entries(node.properties)) visit(child, `${path}.${key}`);
    }
    if (
      node.required !== undefined &&
      (!Array.isArray(node.required) || !node.required.every((key) => typeof key === 'string'))
    ) {
      throw new Error(`${label} ${path}.required must be an array of strings`);
    }
    if (node.items !== undefined) visit(node.items, `${path}[]`);
    if (node.anyOf !== undefined) {
      if (!Array.isArray(node.anyOf)) throw new Error(`${label} ${path}.anyOf must be an array`);
      for (const [index, child] of node.anyOf.entries()) visit(child, `${path}.anyOf[${index}]`);
    }
  };
  visit(value, '$');
  return value;
}

function findVersion(command: string, schema: Schema): number {
  let raw: unknown;
  if (command === 'logs-line') raw = schema.schemaVersion;
  else {
    const properties = asSchema(schema.properties);
    raw = asSchema(properties?.schemaVersion)?.const;
  }
  if (command === 'logs-line' && raw === undefined) return 1;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) {
    throw new Error(
      `${command}: ${command === 'logs-line' ? 'top-level schemaVersion metadata' : 'properties.schemaVersion.const'} must be a positive safe integer`,
    );
  }
  return raw;
}

function addFinding(
  findings: ContractFinding[],
  command: string,
  path: string,
  before: Schema | undefined,
  after: Schema | undefined,
  reason: string,
): void {
  findings.push({ command, path, oldType: typeLabel(before), newType: typeLabel(after), reason });
}

function compareNodes(
  findings: ContractFinding[],
  added: string[],
  command: string,
  path: string,
  before: Schema,
  after: Schema,
): void {
  const oldTypes = typeSet(before);
  const newTypes = typeSet(after);
  if (canonical(oldTypes) !== canonical(newTypes)) {
    addFinding(findings, command, path, before, after, 'field type changed');
    return;
  }

  if (!Array.isArray(before.anyOf) && !Array.isArray(after.anyOf)) {
    compareNodeFields(findings, added, command, path, before, after);
    return;
  }
  const oldBranches = branches(before);
  const newBranches = branches(after);
  for (const oldBranch of oldBranches) {
    const oldBranchTypes = typeSet(oldBranch);
    const matching =
      newBranches.find((candidate) => canonical(candidate) === canonical(oldBranch)) ??
      newBranches.find((candidate) => canonical(typeSet(candidate)) === canonical(oldBranchTypes));
    if (matching) compareNodeFields(findings, added, command, path, oldBranch, matching);
  }
}

function compareNodeFields(
  findings: ContractFinding[],
  added: string[],
  command: string,
  path: string,
  before: Schema,
  after: Schema,
): void {
  const oldProps = asSchema(before.properties);
  const newProps = asSchema(after.properties);
  const oldRequired = new Set(
    Array.isArray(before.required) ? before.required.filter((x): x is string => typeof x === 'string') : [],
  );
  const newRequired = new Set(
    Array.isArray(after.required) ? after.required.filter((x): x is string => typeof x === 'string') : [],
  );

  if (oldProps) {
    for (const [key, oldValue] of Object.entries(oldProps)) {
      if (key === 'schemaVersion' && path === '$') continue;
      const oldChild = asSchema(oldValue);
      const newChild = asSchema(newProps?.[key]);
      const childPath = path === '$' ? key : `${path}.${key}`;
      if (!newChild) {
        addFinding(findings, command, childPath, oldChild, undefined, 'property removed');
        continue;
      }
      if (oldRequired.has(key) && !newRequired.has(key)) {
        addFinding(findings, command, childPath, oldChild, newChild, 'required -> optional');
      }
      if (oldChild) compareNodes(findings, added, command, childPath, oldChild, newChild);
    }
  }

  if (newProps) {
    for (const key of Object.keys(newProps)) {
      if (key === 'schemaVersion' && path === '$') continue;
      if (oldProps && key in oldProps) continue;
      added.push(path === '$' ? key : `${path}.${key}`);
    }
  }

  const oldItems = asSchema(before.items);
  const newItems = asSchema(after.items);
  if (oldItems && newItems) compareNodes(findings, added, command, `${path}[]`, oldItems, newItems);
  else if (oldItems && !newItems)
    addFinding(findings, command, `${path}[]`, oldItems, undefined, 'array items removed');

  const known = new Set(['type', 'anyOf', 'properties', 'required', 'items']);
  const oldUnsupported = Object.fromEntries(Object.entries(before).filter(([key]) => !known.has(key)));
  const newUnsupported = Object.fromEntries(Object.entries(after).filter(([key]) => !known.has(key)));
  if (canonical(oldUnsupported) !== canonical(newUnsupported)) {
    addFinding(findings, command, path, before, after, 'unsupported schema structure changed');
  }
}

export interface CliJsonSchemaDiff {
  command: string;
  oldVersion: number;
  newVersion: number;
  /** Property paths present at the new ref but not the old one, e.g. `breaker`, `lanes[].pr`. */
  added: string[];
  /** Removed / retyped / required->optional / structure-changed findings, computed regardless of version. */
  breaking: ContractFinding[];
}

export function diffCliJsonSchemas(command: string, before: unknown, after: unknown): CliJsonSchemaDiff {
  const oldSchema = validateSchema(before, `${command} base`);
  const newSchema = validateSchema(after, `${command} HEAD`);
  const oldVersion = findVersion(command, oldSchema);
  const newVersion = findVersion(command, newSchema);
  const breaking: ContractFinding[] = [];
  const added: string[] = [];
  compareNodeFields(breaking, added, command, '$', oldSchema, newSchema);
  return { command, oldVersion, newVersion, added, breaking };
}

export function compareCliJsonSchemas(command: string, before: unknown, after: unknown): ContractFinding[] {
  const diff = diffCliJsonSchemas(command, before, after);
  if (diff.newVersion < diff.oldVersion)
    return [
      {
        command,
        path: '$',
        oldType: `schemaVersion ${diff.oldVersion}`,
        newType: `schemaVersion ${diff.newVersion}`,
        reason: 'schemaVersion must not decrease',
      },
    ];
  return diff.newVersion > diff.oldVersion ? [] : diff.breaking;
}

function parseArgs(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--base' || !argv[1] || argv[1].startsWith('-')) {
    throw new Error('usage: check-cli-json-contract.ts --base <ref>');
  }
  return argv[1];
}

function defaultGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
}

export function inventory(ref: string, git: (args: readonly string[]) => string): string[] {
  const output = git(['ls-tree', '-r', '--name-only', '-z', ref, '--', 'packages/cli/schemas']);
  return output
    .split('\0')
    .filter((path) => path.endsWith('.schema.json'))
    .sort();
}

export function readSchema(ref: string, path: string, git: (args: readonly string[]) => string): unknown {
  let raw: string;
  try {
    raw = git(['show', `${ref}:${path}`]);
  } catch (error) {
    throw new Error(`cannot read ${ref}:${path}: ${String(error)}`, { cause: error });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`malformed JSON in ${ref}:${path}: ${String(error)}`, { cause: error });
  }
}

export function runCliJsonContractCheck(argv: readonly string[], io: ContractCheckIo = {}): number {
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  try {
    const base = parseArgs(argv);
    const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const cwd = io.cwd ?? scriptRoot;
    const git = io.git ?? ((args: readonly string[]) => defaultGit(cwd, args));
    const baseFiles = inventory(base, git);
    const headFiles = inventory('HEAD', git);
    if (headFiles.length === 0) throw new Error('HEAD has no CLI schema artifacts under packages/cli/schemas');
    const baseSet = new Set(baseFiles);
    const headSet = new Set(headFiles);
    const findings: ContractFinding[] = [];
    for (const path of [...new Set([...baseFiles, ...headFiles])].sort()) {
      const command =
        path
          .split('/')
          .at(-1)
          ?.replace(/\.schema\.json$/, '') ?? path;
      if (!baseSet.has(path)) continue;
      const before = validateSchema(readSchema(base, path, git), `${base}:${path}`);
      if (!headSet.has(path)) {
        findings.push({
          command,
          path: '$',
          oldType: 'schema',
          newType: '<removed>',
          reason: 'schema file removed; schemaVersion must increase',
        });
        continue;
      }
      const after = validateSchema(readSchema('HEAD', path, git), `HEAD:${path}`);
      findings.push(...compareCliJsonSchemas(command, before, after));
    }
    if (findings.length) {
      for (const finding of findings)
        error(
          `${finding.command} ${finding.path}: ${finding.oldType} -> ${finding.newType}; ${finding.reason}${finding.reason.includes('schemaVersion') ? '' : '; schemaVersion must increase'}`,
        );
      return 1;
    }
    log('check-cli-json-contract: OK');
    return 0;
  } catch (cause) {
    error(`check-cli-json-contract: ${cause instanceof Error ? cause.message : String(cause)}`);
    error('usage: check-cli-json-contract.ts --base <ref>');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runCliJsonContractCheck(process.argv.slice(2));
}
