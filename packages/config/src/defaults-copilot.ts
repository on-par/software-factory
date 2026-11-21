import type { ModelDefaults } from './defaults.js';

export const copilotModels: Record<string, ModelDefaults> = {
  'copilot-default': {
    provider: 'copilot',
    tier: [],
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 128000,
    capabilities: ['planning', 'implementation', 'coding', 'review', 'verification'],
    envKey: null,
    harness: 'copilot-cli',
    experimental: true,
  },
};
