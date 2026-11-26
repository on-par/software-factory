import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ProjectConfigSourcePayload } from '../events/payloads.js';
import { REPO_CONFIG_FILENAMES } from './repo-config-file.js';
import { resolveProjectConfigDir } from './run-config-ladder.js';

const CHECKOUT_INPUTS = [
  ...REPO_CONFIG_FILENAMES.map((name) => `.factory/${name}`),
  '.factory/constitution.md',
  '.factory/agent-memory',
  '.factory/state/product',
  '.factory/tests',
];

export function ignoredCheckoutInputs(repoRoot: string): string[] {
  return CHECKOUT_INPUTS.filter((rel) => existsSync(join(repoRoot, rel))).sort();
}

export function projectConfigReport(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ProjectConfigSourcePayload | undefined {
  const project = resolveProjectConfigDir(env);
  if (!project) return undefined;
  return { source: project.source, dir: project.dir, ignoredInputs: ignoredCheckoutInputs(repoRoot) };
}
