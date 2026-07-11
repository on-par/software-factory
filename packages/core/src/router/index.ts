// src/router/index.ts — Model router with cost-tier routing and automatic failover

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry } from '../models/index.js';
import type { TaskType } from '../types/index.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';

const exec = promisify(execCb);

export type FailoverReason =
  | 'rate_limit'
  | 'usage_cap'
  | 'timeout'
  | 'error'
  | 'empty_response'
  | 'unknown';

export interface RouterResult {
  model: string;
  output: string;
  exitCode: number;
  cost: number;
  attempts: { model: string; reason: FailoverReason | null; ok: boolean }[];
}

export class ModelRouter {
  private registry: ModelRegistry;

  constructor(
    private modelsConfig: ModelsConfig,
    private routesConfig: RoutesConfig,
    private byok = false,
  ) {
    this.registry = new ModelRegistry(modelsConfig);
  }

  get registryRef() { return this.registry; }

  /** Resolve a task type to its tier */
  getTier(task: TaskType): string | undefined {
    return this.routesConfig.routes[task]?.tier;
  }

  /** Resolve a task type to the first available model */
  resolve(task: TaskType): string | undefined {
    const tier = this.getTier(task);
    if (!tier) return undefined;
    return this.registry.getAvailableModelsForTier(tier, this.byok)[0];
  }

  /** Resolve all available models for a task (for failover chain) */
  resolveAll(task: TaskType): string[] {
    const tier = this.getTier(task);
    if (!tier) return [];
    return this.registry.getAvailableModelsForTier(tier, this.byok);
  }

  /** Classify a failure from stderr/exit code */
  classifyFailure(stderr: string, exitCode: number): FailoverReason {
    if (exitCode === 124) return 'timeout';
    const text = stderr.toLowerCase();
    if (/rate.?limit|429|too many requests/.test(text)) return 'rate_limit';
    if (/usage.?limit|quota|billing|insufficient|credit/.test(text)) return 'usage_cap';
    if (/empty|no content|no response/.test(text)) return 'empty_response';
    if (/error|fail|exception/.test(text)) return 'error';
    return 'unknown';
  }

  /**
   * Run a model with failover.
   * Tries the resolved model; on failure, classifies and fails over to the next.
   * Returns the model that succeeded and the output.
   */
  async run(
    task: TaskType,
    prompt: string,
    options: {
      worktree?: string;
      timeout?: number;
      modelOverride?: string;
      onLog?: (msg: string) => void;
    } = {},
  ): Promise<RouterResult> {
    const { worktree = process.cwd(), timeout = 1800, modelOverride, onLog = () => {} } = options;

    const models = modelOverride ? [modelOverride] : this.resolveAll(task);
    if (models.length === 0) {
      throw new Error(`No available models for task '${task}'`);
    }

    const maxRetries = this.registry.failover.maxRetries;
    const cooldownMs = this.registry.failover.cooldownMs;
    const attempts: RouterResult['attempts'] = [];

    for (const model of models) {
      let retries = 0;

      while (retries <= maxRetries) {
        onLog(`Trying ${model} for ${task} (attempt ${retries + 1})`);

        try {
          const output = await this.runModel(model, prompt, { worktree, timeout, task });

          if (output.trim().length > 0) {
            // Success
            attempts.push({ model, reason: null, ok: true });
            return {
              model,
              output: output,
              exitCode: 0,
              cost: 0, // cost tracked separately
              attempts,
            };
          } else {
            attempts.push({ model, reason: 'empty_response', ok: false });
            throw new Error('empty response');
          }
        } catch (err: any) {
          const reason = err.reason ?? this.classifyFailure(err.stderr ?? '', err.exitCode ?? 1);
          attempts.push({ model, reason, ok: false });
          onLog(`${model} failed (${reason}) on ${task}`);

          // Rate limit → retry with cooldown
          if (reason === 'rate_limit' && retries < maxRetries) {
            retries++;
            onLog(`Rate limited — cooldown ${cooldownMs}ms before retry`);
            await sleep(cooldownMs);
            continue;
          }

          // Usage cap → failover immediately
          if (reason === 'usage_cap') {
            onLog(`Usage cap hit on ${model} — failing over to next model`);
            break;
          }

          // Timeout → failover
          if (reason === 'timeout') {
            onLog(`${model} timed out on ${task} — failing over`);
            break;
          }

          // Generic error → retry once, then failover
          if (reason === 'error' && retries < 1) {
            retries++;
            continue;
          }

          // Empty response → failover
          break;
        }
      }
    }

    throw new Error(`All models failed for task '${task}': ${attempts.map(a => `${a.model}(${a.reason})`).join(', ')}`);
  }

  /** Run a single model via Claude CLI or Codex CLI */
  private async runModel(
    model: string,
    prompt: string,
    options: { worktree: string; timeout: number; task: TaskType },
  ): Promise<string> {
    const def = this.registry.get(model);
    if (!def) throw new Error(`Unknown model: ${model}`);

    const { worktree, timeout } = options;

    if (def.codex && (options.task === 'build_codex' || this.routesConfig.routes[options.task]?.requires === 'codex')) {
      return this.runCodex(model, prompt, worktree, timeout);
    }
    return this.runClaude(model, prompt, worktree, timeout);
  }

  /** Run via Claude CLI: claude -p <prompt> --model <flag> --dangerously-skip-permissions */
  private async runClaude(model: string, prompt: string, worktree: string, timeout: number): Promise<string> {
    const flag = this.registry.getClaudeFlag(model);
    const modelArg = flag ? `--model ${flag}` : '';
    const cmd = `claude -p ${shellEscape(prompt)} ${modelArg} --dangerously-skip-permissions`;

    try {
      const { stdout } = await exec(cmd, {
        cwd: worktree,
        timeout: timeout * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch (err: any) {
      err.reason = err.killed ? 'timeout' : this.classifyFailure(err.stderr ?? '', err.code ?? 1);
      throw err;
    }
  }

  /** Run via Codex CLI: codex exec --yolo -C <worktree> [flags] -o <output> - < prompt */
  private async runCodex(model: string, prompt: string, worktree: string, timeout: number): Promise<string> {
    const extraFlag = this.registry.getCodexFlag(model) ?? '';
    const tmpFile = await mktemp(join(tmpdir(), 'factory-codex-'));
    const outFile = await mktemp(join(tmpdir(), 'factory-codex-out-'));
    await writeFile(tmpFile, prompt);

    const cmd = `codex exec --yolo -C ${shellEscape(worktree)} ${extraFlag} -o ${shellEscape(outFile)} - < ${shellEscape(tmpFile)}`;

    try {
      await exec(cmd, { timeout: timeout * 1000, maxBuffer: 10 * 1024 * 1024 });
      const output = await readFile(outFile, 'utf-8').catch(() => '');
      return output;
    } catch (err: any) {
      err.reason = err.killed ? 'timeout' : this.classifyFailure(err.stderr ?? '', err.code ?? 1);
      throw err;
    } finally {
      // Cleanup temp files
      await writeFile(tmpFile, '').catch(() => {});
      await writeFile(outFile, '').catch(() => {});
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Minimal shell escaping for safe CLI args */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function mktemp(prefix: string): Promise<string> {
  const { writeFile } = await import('node:fs/promises');
  const path = `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(path, '');
  return path;
}