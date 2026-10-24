// src/config/optional-sections.ts — opt-in top-level sections of the v2 repo config

import { QaConfigSections } from './qa-section.js';
import { RiskConfigSections } from './risk-section.js';
import { TestsConfigSections } from './tests-section.js';

export const OptionalConfigSections = { ...RiskConfigSections, ...QaConfigSections, ...TestsConfigSections };
