// src/config/sandbox-schema.ts — zod schema for the `sandbox` section of the factory config.

import { homedir } from 'node:os';

import { z } from 'zod';

import { writablePathError } from '../sandbox/writable-paths.js';

export const CODEX_SANDBOX_MODES = ['danger-full-access', 'workspace-write'] as const;

export const SandboxConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    runtime: z.enum(['auto', 'sandbox-exec', 'firejail', 'docker-sandbox', 'none']).default('auto'),
    codexFullAccessTasks: z.array(z.string()).optional(),
    codexSandbox: z.enum(CODEX_SANDBOX_MODES).optional().catch(undefined),
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** ADR-0160 warn stage (#3829): an unknown sandbox.codexSandbox is ignored with a warning; a later release rejects it. Shared by the loader, run start and doctor. */
export function codexSandboxValueIssue(
  raw: Record<string, unknown>,
): { value: unknown; message: string; fix: string } | undefined {
  const sandbox = raw.sandbox;
  if (!isRecord(sandbox) || !('codexSandbox' in sandbox)) return undefined;
  const value = sandbox.codexSandbox;
  if (typeof value === 'string' && (CODEX_SANDBOX_MODES as readonly string[]).includes(value)) return undefined;
  return {
    value,
    message: `sandbox.codexSandbox is ${JSON.stringify(value)}, which is not one of "danger-full-access", "workspace-write"; it is ignored (treated as unset) and will be an error in a later release`,
    fix: 'set sandbox.codexSandbox to "danger-full-access" or "workspace-write", or remove it (see docs/config.example.yaml)',
  };
}

/** Unknown sandbox.codexSandbox values already warned about, keyed by path and value. */
const warnedCodexSandbox = new Set<string>();

/** Loader warning (#3829): console.warn an unknown sandbox.codexSandbox once per config path and value. */
export function warnCodexSandboxOnce(configPath: string, raw: Record<string, unknown>): void {
  const issue = codexSandboxValueIssue(raw);
  if (!issue) return;
  const key = `${configPath}\0${JSON.stringify(issue.value)}`;
  if (warnedCodexSandbox.has(key)) return;
  warnedCodexSandbox.add(key);
  console.warn(`factory: ${configPath}: ${issue.message}; ${issue.fix}`);
}
