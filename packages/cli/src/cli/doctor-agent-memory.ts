// packages/cli/src/cli/doctor-agent-memory.ts — `factory doctor` warns about oversized lane memory files (#3624)

import { AGENT_MEMORY_MAX_BYTES, scanAgentMemory } from '@on-par/factory-core/internal';

import { REPO_SECTION, type DoctorCheck } from './doctor.js';

/** One optional warning row per `.factory/agent-memory/*.md` file over the cap (PLAN ignores it). Empty when
 *  the directory is missing or every file fits. */
export async function agentMemoryChecks(repoRoot: string): Promise<DoctorCheck[]> {
  const files = await scanAgentMemory(repoRoot);
  return files
    .filter((f) => f.oversized)
    .map((f) => ({
      name: 'agent memory',
      ok: false,
      optional: true,
      section: REPO_SECTION,
      detail: `${f.file} is ${f.bytes} bytes, over the ${AGENT_MEMORY_MAX_BYTES}-byte cap; PLAN ignores it`,
      fix: `trim ${f.file} below ${AGENT_MEMORY_MAX_BYTES} bytes in a pull request`,
    }));
}
