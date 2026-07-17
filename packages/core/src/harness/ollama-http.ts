// src/harness/ollama-http.ts — CodingHarness adapter for Ollama's native HTTP chat API.

import { classifyFailure } from './classify.js';
import type { CodingHarness, HarnessRequest, HarnessResult } from './index.js';
import { HarnessError } from './index.js';

/** Structurally identical to the router's FetchFn — defined here so the harness
 *  does not import from ../router (avoids an import cycle). */
export type OllamaFetchFn = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

/** Prompt-only harness for Ollama's native HTTP chat API. Not agentic:
 *  it never edits files in the worktree — `worktree`/`task` on the
 *  request are ignored. Build routes must not select it. */
export class OllamaHttpHarness implements CodingHarness {
  readonly id = 'ollama-http';
  readonly agentic = false;

  constructor(private fetchFn: OllamaFetchFn = globalThis.fetch as unknown as OllamaFetchFn) {}

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, timeoutSeconds, registry } = request;
    const baseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const nativeModel = registry.getProviderModel(model);
    const options = registry.getProviderOptions(model);

    try {
      const res = await this.fetchFn(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
        body: JSON.stringify({
          model: nativeModel,
          stream: false,
          messages: [{ role: 'user', content: prompt }],
          ...(options ? { options } : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new HarnessError(`ollama ${res.status} ${res.statusText}: ${body}`, classifyFailure(body, res.status), {
          exitCode: res.status,
          stderr: body,
        });
      }

      const data = (await res.json()) as { message?: { content?: string }; response?: string; error?: string };
      if (data.error) {
        throw new HarnessError(data.error, classifyFailure(data.error, 1), { exitCode: 1, stderr: data.error });
      }

      const output = data.message?.content ?? data.response ?? '';
      if (output.trim().length === 0) {
        throw new HarnessError('ollama returned empty output', 'empty_response', { exitCode: 0 });
      }
      return { output };
    } catch (err: any) {
      if (err instanceof HarnessError) throw err;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new HarnessError(err.message ?? String(err), 'timeout', {});
      }
      throw new HarnessError(
        err.message ?? String(err),
        err.reason ?? classifyFailure(err.stderr ?? err.message ?? '', err.code ?? 1),
        {
          exitCode: typeof err.code === 'number' ? err.code : undefined,
          stderr: err.stderr,
          code: typeof err.code === 'string' || typeof err.code === 'number' ? err.code : undefined,
          signal: typeof err.signal === 'string' ? err.signal : undefined,
          killed: err.killed === true ? true : undefined,
        },
      );
    }
  }
}
