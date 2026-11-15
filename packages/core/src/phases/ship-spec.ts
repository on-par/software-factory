import { readDesignArtifact } from '../design/index.js';
import { readSpec } from '../spec/index.js';

export async function readSpecBody(specPath: string | undefined): Promise<string | undefined> {
  if (!specPath) return undefined;
  try {
    return (await readSpec(specPath)).body;
  } catch {
    return undefined;
  }
}

export async function readRisk(specPath: string | undefined): Promise<string | undefined> {
  if (!specPath) return undefined;
  try {
    return (await readDesignArtifact(specPath))?.riskBlastRadius;
  } catch {
    return undefined;
  }
}
