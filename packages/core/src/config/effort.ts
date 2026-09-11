import { z } from 'zod';

const EffortSchema = z.union([
  z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  z.boolean(),
]);

export const ModelEffortsSchema = z
  .record(z.string(), z.union([EffortSchema, z.record(z.string(), EffortSchema)]))
  .describe(
    'Model id -> effort, or task type -> effort. Omitted tasks retain provider/profile defaults. Boolean values are Ollama thinking toggles.',
  );

/** Transport-level support; the selected provider/model remains authoritative for availability. */
export function supportsEffort(harness: string | undefined, effort: z.infer<typeof EffortSchema>): boolean {
  switch (harness) {
    case 'codex-cli':
    case 'opencode':
      return typeof effort === 'string';
    case 'claude-cli':
      return ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(effort));
    case 'ollama-http':
    case 'ollama-agentic':
    case 'ollama-command-agent':
      return typeof effort === 'boolean' || ['low', 'medium', 'high', 'max'].includes(effort);
    default:
      return false;
  }
}
