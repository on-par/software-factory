import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveProjectConfigDir } from './run-config-ladder.js';

export type ProjectInput = 'agent-memory' | 'product' | 'tests';

export const PRODUCT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export interface ProjectInputLocation {
  path: string;
  external: boolean;
}

export function resolveProjectInput(
  input: ProjectInput,
  checkoutPath: string,
  env: NodeJS.ProcessEnv = process.env,
): ProjectInputLocation {
  const project = resolveProjectConfigDir(env);
  return project ? { path: join(project.dir, input), external: true } : { path: checkoutPath, external: false };
}

export interface ReadProductDeps {
  fileExists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  env?: NodeJS.ProcessEnv;
}

export function readProductInput(checkoutPath: string, deps: ReadProductDeps = {}): string | undefined {
  const { fileExists = existsSync, readFile = (p: string) => readFileSync(p, 'utf-8'), env = process.env } = deps;
  const { path } = resolveProjectInput('product', checkoutPath, env);
  if (!fileExists(path)) return undefined;
  return readFile(path).trim() || undefined;
}

export function writeProductInput(checkoutPath: string, product: string, env: NodeJS.ProcessEnv = process.env): string {
  const { path } = resolveProjectInput('product', checkoutPath, env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, product);
  return path;
}
