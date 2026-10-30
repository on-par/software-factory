import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  coreFakes,
  DEFAULT_CODE_FIXTURE,
  h,
  installCliCommandsHarness,
  logged,
  logSpy,
  runMain,
} from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('init and models --doctor parity', () => {
    it('prints the same reachable count as models --doctor and passes the same probes', async () => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      writeFileSync(join(h.constitutionsDir, 'default-code.md'), DEFAULT_CODE_FIXTURE);
      h.diagnoses = [
        {
          model: 'a',
          provider: 'anthropic',
          tiers: ['worker'],
          reachable: false,
          unverified: true,
          experimental: false,
          reason: 'r',
        },
        {
          model: 'b',
          provider: 'openai',
          tiers: ['worker'],
          reachable: false,
          unverified: true,
          experimental: false,
          reason: 'r',
        },
        { model: 'c', provider: 'ollama', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      ] as any[];
      const count = '1/3 models reachable, 2 unverified (no auth evidence)';
      await runMain('init');
      expect(logged()).toContain(count);
      expect(coreFakes.diagnoseModels).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ ollamaModelPresent: undefined }),
        expect.anything(),
        expect.anything(),
      );
      logSpy.mockClear();
      await runMain('models', '--doctor');
      expect(logged()).toContain(count);
      expect(coreFakes.diagnoseModels).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ ollamaModelPresent: undefined }),
        expect.anything(),
        expect.anything(),
      );
    });
  });
});
