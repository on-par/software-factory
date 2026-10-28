import type { EvidenceAllowlist } from './evidence-allowlist.js';
import { tokenizeEvidenceCommand } from './evidence-allowlist.js';

export interface FailToPassSelector {
  file: string;
  names: readonly string[];
}

export type EvidenceTestRunner = 'vitest' | 'jest' | 'pytest';

export const SELECTOR_UNUSABLE_PREFIX = 'selector could not be used';

const TEST_FILE = [/\.(test|spec)\.[cm]?[jt]sx?$/, /^test_[^/]*\.py$/, /_test\.py$/];
const DASHES = new Set(['-', '–', '—']);
const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUNNERS: readonly EvidenceTestRunner[] = ['vitest', 'jest', 'pytest'];

interface Token {
  value: string;
  quoted: boolean;
}

function scan(text: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === ' ' || char === '\t') {
      i += 1;
    } else if (char === '"' || char === "'") {
      const end = text.indexOf(char, i + 1);
      if (end < 0) return null;
      tokens.push({ value: text.slice(i + 1, end), quoted: true });
      i = end + 1;
    } else {
      let end = i;
      while (end < text.length && text[end] !== ' ' && text[end] !== '\t' && text[end] !== '"' && text[end] !== "'") {
        end += 1;
      }
      if (end < text.length && text[end] !== ' ' && text[end] !== '\t') return null;
      tokens.push({ value: text.slice(i, end), quoted: false });
      i = end;
    }
  }
  return tokens;
}

export function parseFailToPassSelector(text: string): FailToPassSelector | null {
  const tokens = scan(text.trim());
  if (!tokens || tokens.length === 0) return null;
  const [first, ...rest] = tokens;
  let file = first!.value;
  if (!first!.quoted && file.endsWith(':')) file = file.slice(0, -1);
  const names: string[] = [];
  const split = file.indexOf('::');
  if (split >= 0) {
    const name = file.slice(split + 2);
    file = file.slice(0, split);
    if (!name) return null;
    names.push(name);
  }
  if (!file || file.startsWith('-')) return null;
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (!TEST_FILE.some((pattern) => pattern.test(base))) return null;
  const tail = rest.length > 0 && !rest[0]!.quoted && DASHES.has(rest[0]!.value) ? rest.slice(1) : rest;
  for (const token of tail) {
    if (!token.quoted || !token.value) return null;
    names.push(token.value);
  }
  return { file, names: [...new Set(names)] };
}

const WRAPPERS: readonly (readonly string[])[] = [
  ['npx'],
  ['bunx'],
  ['pnpm', 'exec'],
  ['pnpm'],
  ['yarn'],
  ['python', '-m'],
  ['python3', '-m'],
  ['uv', 'run'],
  ['poetry', 'run'],
];

export function resolveEvidenceTestRunner(
  allowlist: EvidenceAllowlist,
  packageJson: unknown,
): EvidenceTestRunner | null {
  const argv = allowlist.get('test');
  if (!argv) return null;
  let words: readonly string[] | null = argv;
  if (argv.length === 3 && MANAGERS.has(argv[0]!) && argv[1] === 'run' && argv[2] === 'test') {
    if (packageJson === null || typeof packageJson !== 'object' || Array.isArray(packageJson)) return null;
    const scripts = (packageJson as Record<string, unknown>).scripts;
    if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return null;
    const body = (scripts as Record<string, unknown>).test;
    if (typeof body !== 'string') return null;
    words = tokenizeEvidenceCommand(body);
    if (!words) return null;
  }
  const wrapper = WRAPPERS.find((prefix) => prefix.every((part, index) => words[index] === part));
  const command = words[wrapper ? wrapper.length : 0];
  const name = command?.slice(command.lastIndexOf('/') + 1);
  return RUNNERS.find((runner) => runner === name) ?? null;
}

export function selectorArgs(selector: FailToPassSelector, runner: EvidenceTestRunner): string[] {
  const { file, names } = selector;
  if (runner === 'pytest') return names.length ? names.map((name) => `${file}::${name}`) : [file];
  if (names.length === 0) return [file];
  return [file, '-t', names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')];
}
