// Keeps the `.github/ISSUE_TEMPLATE/*.yml` form field labels coupled to the
// scorer's required-field constants — a rename on one side without the other
// would silently break readiness scoring for real issues.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EPIC_REQUIRED_FIELDS, FACTORY_BUG_REQUIRED_FIELDS, FACTORY_TASK_REQUIRED_FIELDS } from './index.js';

function readTemplate(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../.github/ISSUE_TEMPLATE/${file}`, import.meta.url)), 'utf-8');
}

describe('issue templates <-> readiness scorer coupling', () => {
  it('factory-task.yml carries every FACTORY_TASK_REQUIRED_FIELDS label', () => {
    const template = readTemplate('factory-task.yml');
    for (const field of FACTORY_TASK_REQUIRED_FIELDS) {
      expect(template).toContain(`label: ${field}`);
    }
  });

  it('factory-bug.yml carries every FACTORY_BUG_REQUIRED_FIELDS label', () => {
    const template = readTemplate('factory-bug.yml');
    for (const field of FACTORY_BUG_REQUIRED_FIELDS) {
      expect(template).toContain(`label: ${field}`);
    }
  });

  it('epic.yml carries every EPIC_REQUIRED_FIELDS label', () => {
    const template = readTemplate('epic.yml');
    for (const field of EPIC_REQUIRED_FIELDS) {
      expect(template).toContain(`label: ${field}`);
    }
  });

  it('config.yml disables blank issues', () => {
    const template = readTemplate('config.yml');
    expect(template).toContain('blank_issues_enabled: false');
  });
});
