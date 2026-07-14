import { CodingHarness, HarnessError, HarnessRequest, HarnessResult, HarnessFailureReason } from './index.js';

export type StubHarnessStep =
  | { output: string }
  | { fail: HarnessFailureReason; message?: string };

export interface StubCodingHarnessOptions {
  id?: string;
  agentic?: boolean;
  /** Fallback output when no scripted steps remain. */
  defaultOutput?: string;
}

export class StubCodingHarness implements CodingHarness {
  readonly id: string;
  readonly agentic: boolean;
  readonly calls: HarnessRequest[] = [];
  private steps: StubHarnessStep[];

  constructor(steps: StubHarnessStep[] = [], private options: StubCodingHarnessOptions = {}) {
    this.steps = [...steps];
    this.id = options.id ?? 'stub';
    this.agentic = options.agentic ?? true;
  }

  async run(request: HarnessRequest): Promise<HarnessResult> {
    this.calls.push(request);
    const step = this.steps.shift();

    if (step && 'fail' in step) {
      throw new HarnessError(step.message ?? `stub failure: ${step.fail}`, step.fail, { exitCode: 1 });
    }

    const output = step && 'output' in step
      ? step.output
      : this.options.defaultOutput;
    if (output === undefined) {
      throw new Error('StubCodingHarness: no scripted step or defaultOutput remaining');
    }

    if (output.trim().length === 0) {
      throw new HarnessError('stub returned empty output', 'empty_response');
    }
    return { output };
  }
}
