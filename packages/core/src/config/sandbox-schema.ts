// src/config/sandbox-schema.ts — zod schema for the `sandbox` section of the factory config.

import { homedir } from 'node:os';

import { z } from 'zod';

import { writablePathError } from '../sandbox/writable-paths.js';

export const SandboxConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    runtime: z.enum(['auto', 'sandbox-exec', 'firejail', 'docker-sandbox', 'none']).default('auto'),
    codexFullAccessTasks: z.array(z.string()).optional(),
    writablePaths: z
      .array(
        z.string().superRefine((entry, ctx) => {
          const why = writablePathError(entry, { home: homedir() });
          if (why) ctx.addIssue({ code: 'custom', message: `"${entry}" ${why}` });
        }),
      )
      .optional(),
    network: z
      .object({
        allow: z.array(z.string()).default(['api.anthropic.com', 'github.com']),
        blockTelemetry: z.boolean().optional(),
        mode: z.enum(['report', 'enforce']).optional(),
      })
      .default({ allow: ['api.anthropic.com', 'github.com'], blockTelemetry: false, mode: 'report' }),
    resources: z
      .object({ cpuMs: z.number().positive().default(300_000), memMb: z.number().positive().default(4096) })
      .default({ cpuMs: 300_000, memMb: 4096 }),
    docker: z.object({ rolloutPercent: z.number().min(0).max(100).default(0) }).default({ rolloutPercent: 0 }),
    comment: z.string().optional(),
  })
  .default({
    enabled: true,
    runtime: 'auto',
    codexFullAccessTasks: [],
    writablePaths: [],
    network: { allow: ['api.anthropic.com', 'github.com'], blockTelemetry: false, mode: 'report' },
    resources: { cpuMs: 300_000, memMb: 4096 },
    docker: { rolloutPercent: 0 },
  });
