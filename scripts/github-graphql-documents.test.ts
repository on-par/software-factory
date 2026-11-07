// Every GitHub GraphQL document the factory sends validates against GitHub's published public schema.
//
// Unit tests stub GraphQL responses, so they never notice a document GitHub would reject. This suite finds every
// `.graphql(` / `.graphql<T>(` call in the shipped package sources, resolves its document (an inline literal, a
// same-file `const`, or a named builder below) and runs graphql-js `validate` against the schema shipped in
// `@octokit/graphql-schema`. A call whose document cannot be resolved fails, so a new query cannot skip the check.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { schema as githubSchema } from '@octokit/graphql-schema';
import { buildClientSchema, extendSchema, parse, validate, type GraphQLSchema, type IntrospectionQuery } from 'graphql';
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
  const sites: CallSite[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (TEST_ONLY.test(rel)) continue;
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(/\.graphql\s*(?=[<(])/g)) {
      let i = match.index + match[0].length;
      if (src[i] === '<') i = skipTypeArguments(src, i);
      if (src[i] !== '(') continue;
      i++;
      while (/\s/.test(src[i] ?? '')) i++;
      const line = src.slice(0, match.index).split('\n').length;
      sites.push({ site: `${rel}:${line}`, documents: documentsAt(src, i) ?? [] });
    }
  }
  return sites;
}

/**
 * Fields GitHub serves that the pinned `@octokit/graphql-schema` snapshot predates, copied verbatim from GitHub's
 * public schema (https://docs.github.com/public/fpt/schema.docs.graphql). `extendSchema` throws once the snapshot
 * defines one of them itself, so a dependency update that catches up fails here until the entry is deleted.
 */
const NEWER_THAN_SNAPSHOT = `
  extend type Issue {
    subIssues(after: String, before: String, first: Int, last: Int): IssueConnection!
  }
`;

/** The package types its introspection JSON loosely; fail loudly if its shape ever changes. */
function introspection(json: Record<string, unknown>): IntrospectionQuery {
  const { __schema } = json;
  if (typeof __schema !== 'object' || __schema === null || !('types' in __schema)) {
    throw new Error('@octokit/graphql-schema: schema.json has no __schema.types');
  }
  return { __schema } as IntrospectionQuery;
}

// The introspection result, not `schema.idl`: the published SDL repeats two `EnterpriseOwnerInfo` fields, which
// graphql-js's SDL validation rejects. Introspection is what GitHub's own endpoint returns.
let cachedSchema: GraphQLSchema | undefined;
function github(): GraphQLSchema {
  cachedSchema ??= extendSchema(buildClientSchema(introspection(githubSchema.json)), parse(NEWER_THAN_SNAPSHOT));
  return cachedSchema;
}

const errorsIn = (document: string): string[] => validate(github(), parse(document)).map((e) => e.message);

const sites = graphqlCallSites();

describe('GitHub GraphQL documents', () => {
  it('finds the call sites, including the self-identity viewer query', () => {
    expect(sites.length).toBeGreaterThanOrEqual(10);
    expect(sites.map((s) => s.site)).toContainEqual(
      expect.stringMatching(/^packages\/core\/src\/utils\/github-identity\.ts:/),
    );
  });

  it.each(sites.map((s) => [s.site, s] as const))('%s sends a document GitHub accepts', (_site, { documents }) => {
    expect(documents, 'document not resolvable: inline it, use a same-file const, or add a BUILDERS entry').not.toEqual(
      [],
    );
    for (const document of documents) expect(errorsIn(document), document).toEqual([]);
  });

  it('rejects the viewer query that spread `... on Bot` inside `User` (0.9.31)', () => {
    expect(errorsIn('query { viewer { __typename login ... on Bot { databaseId } } }')).toEqual([
      'Fragment cannot be spread here as objects of type "User" can never be of type "Bot".',
    ]);
  });
});
