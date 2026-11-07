// Every GitHub GraphQL document the factory sends validates against GitHub's published public schema.
//
// Unit tests stub GraphQL responses, so they never notice a document GitHub would reject. This suite finds every
// `.graphql(` / `.graphql<T>(` call in the shipped package sources, resolves its document (an inline literal, a
// same-file `const`, or a named builder below) and runs graphql-js `validate` against the text schema shipped in
// `@octokit/graphql-schema`. Any other `.graphql` shape (`.graphql?.(`, `.graphql<T>` with no call) and any document
// it cannot resolve fail the suite, so a new query cannot skip the check.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { schema as githubSchema } from '@octokit/graphql-schema';
import { buildSchema, parse, specifiedRules, validate, type GraphQLSchema } from 'graphql';
import { describe, expect, it } from 'vitest';

import { buildPrDetailsQuery } from '../packages/core/src/kpis/sweep.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Documents built at run time, keyed by the builder called as the first `.graphql(` argument. */
const BUILDERS: Record<string, () => string[]> = {
  buildPrDetailsQuery: () => [buildPrDetailsQuery([1]), buildPrDetailsQuery([1, 2, 3])],
};

/** Test doubles and fixtures call `.graphql(` with placeholder strings; they never reach GitHub. */
const TEST_ONLY = /(\.test\.tsx?$|\/(test-support|__fixtures__|fakes)\/)/;

interface CallSite {
  site: string;
  documents: string[];
  /** Set when the call's shape is not one this reader understands; the site then fails the suite. */
  problem?: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Index just past a balanced `<...>` type argument list starting at `start`. */
function skipTypeArguments(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '<') depth++;
    else if (src[i] === '>' && src[i - 1] !== '=' && --depth === 0) return i + 1;
  }
  return src.length;
}

/** The string literal at `start`: its text, or undefined when it interpolates (`${`) or is not a literal. */
function literalAt(src: string, start: number): string | undefined {
  const quote = src[start];
  if (quote !== '`' && quote !== "'" && quote !== '"') return undefined;
  let text = '';
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') {
      text += src[++i];
      continue;
    }
    if (src[i] === quote) return text;
    if (quote === '`' && src[i] === '$' && src[i + 1] === '{') return undefined;
    text += src[i];
  }
  return undefined;
}

function documentsAt(src: string, start: number): string[] | undefined {
  const literal = literalAt(src, start);
  if (literal !== undefined) return [literal];
  const name = /^[A-Za-z_$][\w$]*/.exec(src.slice(start))?.[0];
  if (name === undefined) return undefined;
  if (src[start + name.length] === '(') return BUILDERS[name]?.();
  const decl = new RegExp(`^(?:export )?const ${name}\\s*=\\s*`, 'm').exec(src);
  const value = decl ? literalAt(src, decl.index + decl[0].length) : undefined;
  return value === undefined ? undefined : [value];
}

function graphqlCallSites(): CallSite[] {
  const files = readdirSync(join(ROOT, 'packages')).flatMap((pkg) => {
    try {
      return sourceFiles(join(ROOT, 'packages', pkg, 'src'));
    } catch {
      return [];
    }
  });
  return files.flatMap((file) => {
    const rel = relative(ROOT, file);
    return TEST_ONLY.test(rel) ? [] : callSitesIn(rel, readFileSync(file, 'utf8'));
  });
}

const skipSpace = (src: string, start: number): number => {
  let i = start;
  while (/\s/.test(src[i] ?? '')) i++;
  return i;
};

/**
 * The `.graphql` call sites in one source file. `.graphql` followed by `<`, `(` or `?.` is a call, or a shape this
 * reader refuses: it records a `problem` for the site instead of skipping it, so the site fails the suite.
 */
function callSitesIn(rel: string, src: string): CallSite[] {
  const sites: CallSite[] = [];
  for (const match of src.matchAll(/\.graphql\s*(?=[<(]|\?\.)/g)) {
    const site = `${rel}:${src.slice(0, match.index).split('\n').length}`;
    let i = match.index + match[0].length;
    if (src.startsWith('?.', i)) {
      sites.push({ site, documents: [], problem: 'optional call `.graphql?.(`' });
      continue;
    }
    if (src[i] === '<') i = skipSpace(src, skipTypeArguments(src, i));
    if (src[i] !== '(') {
      sites.push({ site, documents: [], problem: '`.graphql<T>` not followed by a call `(`' });
      continue;
    }
    sites.push({ site, documents: documentsAt(src, skipSpace(src, i + 1)) ?? [] });
  }
  return sites;
}

/**
 * GitHub's public schema, built from the package's text SDL (`schema.graphql`, exposed as `schema.idl`). Upstream
 * keeps the text schema current. The package's `schema.json` introspection copy lags it: it lacks newer fields and
 * still carries removed ones, so it is not used.
 *
 * `assumeValidSDL: true` skips only graphql-js's SDL validation of the schema definition itself
 * (`specifiedSDLRules`). That validation rejects the upstream file because it defines two `EnterpriseOwnerInfo`
 * fields twice. It does not relax validation of the documents under test: `errorsIn` runs each one through
 * graphql-js `validate()` with every rule in `specifiedRules` (fields exist, fragment spreads are possible,
 * arguments are typed correctly, and so on). `validate()` also still checks the built schema's type system first,
 * because `assumeValid` stays false.
 */
let cachedSchema: GraphQLSchema | undefined;
function github(): GraphQLSchema {
  cachedSchema ??= buildSchema(githubSchema.idl, { assumeValidSDL: true });
  return cachedSchema;
}

const errorsIn = (document: string): string[] =>
  validate(github(), parse(document), specifiedRules).map((e) => e.message);

const sites = graphqlCallSites();

describe('GitHub GraphQL documents', () => {
  it('finds the call sites, including the self-identity viewer query', () => {
    expect(sites.length).toBeGreaterThanOrEqual(10);
    expect(sites.map((s) => s.site)).toContainEqual(
      expect.stringMatching(/^packages\/core\/src\/utils\/github-identity\.ts:/),
    );
  });

  it.each(sites.map((s) => [s.site, s] as const))(
    '%s sends a document GitHub accepts',
    (_site, { documents, problem }) => {
      expect(problem, 'call shape not understood: call `.graphql(` or `.graphql<T>(` directly').toBeUndefined();
      expect(
        documents,
        'document not resolvable: inline it, use a same-file const, or add a BUILDERS entry',
      ).not.toEqual([]);
      for (const document of documents) expect(errorsIn(document), document).toEqual([]);
    },
  );

  it('reads direct calls, with or without type arguments', () => {
    const src = "a.graphql('query { viewer { login } }');\nb.graphql<{ x: number }>(\n  `query { viewer { id } }`,\n);";
    expect(callSitesIn('f.ts', src)).toEqual([
      { site: 'f.ts:1', documents: ['query { viewer { login } }'] },
      { site: 'f.ts:2', documents: ['query { viewer { id } }'] },
    ]);
  });

  it.each([
    ['an optional call', "octokit.graphql?.('query { viewer { login } }');", /optional call/],
    ['an optional call after a space', "octokit.graphql ?.('query { viewer { login } }');", /optional call/],
    ['type arguments without a call', 'const run = octokit.graphql<Viewer>;', /not followed by a call/],
  ])('refuses %s instead of skipping it', (_label, src, problem) => {
    expect(callSitesIn('f.ts', src)).toEqual([
      { site: 'f.ts:1', documents: [], problem: expect.stringMatching(problem) },
    ]);
  });

  it('rejects the viewer query that spread `... on Bot` inside `User` (0.9.31)', () => {
    expect(errorsIn('query { viewer { __typename login ... on Bot { databaseId } } }')).toEqual([
      'Fragment cannot be spread here as objects of type "User" can never be of type "Bot".',
    ]);
  });
});
