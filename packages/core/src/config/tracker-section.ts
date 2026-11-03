import { z } from 'zod';

export const TRACKER_KINDS = ['github', 'linear'] as const;
export type TrackerKind = (typeof TRACKER_KINDS)[number];

const name = z.string().trim().min(1);

export const LinearTrackerSchema = z
  .object({
    teamKey: name.describe('Linear team key, e.g. ENG'),
    projects: z
      .record(name, z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected owner/repo'))
      .default({})
      .describe('Linear project name (or id) → GitHub owner/repo it ships to'),
    readyLabel: name.default('factory:ready'),
    laneLabelGroup: name.default('lane'),
    states: z
      .object({ ready: name.default('Todo'), inProgress: name.default('In Progress'), parked: name.default('Todo') })
      .strict()
      .default({ ready: 'Todo', inProgress: 'In Progress', parked: 'Todo' }),
  })
  .strict(); // rejects apiKey: the key comes only from LINEAR_API_KEY
export type LinearTrackerConfig = z.infer<typeof LinearTrackerSchema>;

export const TrackerConfigSchema = z
  .object({ kind: z.enum(TRACKER_KINDS).default('github'), linear: LinearTrackerSchema.optional() })
  .strict()
  .refine((t) => t.kind !== 'linear' || t.linear !== undefined, {
    message: 'tracker.kind linear needs a tracker.linear block',
    path: ['linear'],
  });
export type TrackerConfig = z.infer<typeof TrackerConfigSchema>;

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = { kind: 'github' };

/** The tracker section; a hand-built config with no tracker resolves to github. */
export function resolveTrackerConfig(config: { tracker?: TrackerConfig }): TrackerConfig {
  return config.tracker ?? DEFAULT_TRACKER_CONFIG;
}
