import type { FactoryConfig, ModelsConfig, RoutesConfig } from '../config/index.js';
import type { EffectiveConfig } from '../config/repo.js';

export interface RunBudget {
  perIssueCapUsd?: number;
}

export interface RunPolicy {
  models: ModelsConfig;
  routes: RoutesConfig;
  sandbox: FactoryConfig['sandbox'];
  budget: RunBudget;
  effective: EffectiveConfig;
  pr?: {
    draft: boolean;
    footer?: string;
    walkthrough?: { minLines?: number; minFiles?: number };
    evidenceComment?: boolean;
  };
}
