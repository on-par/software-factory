// src/config/optional-sections.ts — opt-in top-level sections of the v2 repo config

import { PreviewConfigSections } from './preview-section.js';
import { QaConfigSections } from './qa-section.js';
import { RiskConfigSections } from './risk-section.js';
import { TestsConfigSections } from './tests-section.js';
import { VisualProofConfigSections } from './visual-proof-section.js';

export const OptionalConfigSections = {
  ...RiskConfigSections,
  ...QaConfigSections,
  ...PreviewConfigSections,
  ...TestsConfigSections,
  ...VisualProofConfigSections,
};
