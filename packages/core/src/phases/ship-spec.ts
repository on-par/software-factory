// packages/core/src/phases/ship-spec.ts — spec-derived PR body inputs for the SHIP phase

import { readDesignArtifact } from '../design/index.js';
import { readSpec } from '../spec/index.js';

/** The frozen spec body for the PR description; undefined when there is no readable spec. */
export async function readSpecBody(specPath: string | undefined): Promise<string | undefined> {
  if (!specPath) return undefined;
  try {
    return (await readSpec(specPath)).body;
  } catch {
    return undefined;
  }
}

/** The design artifact's Risk / blast radius for the PR body; undefined when there is no readable artifact. */
export async function readRisk(specPath: string | undefined): Promise<string | undefined> {
  if (!specPath) return undefined;
  try {
    return (await readDesignArtifact(specPath))?.riskBlastRadius;
  } catch {
    return undefined;
  }
}
