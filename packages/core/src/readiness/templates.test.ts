// Keeps the `.github/ISSUE_TEMPLATE/*.yml` form field labels coupled to the
// scorer's required-field constants — a rename on one side without the other
// would silently break readiness scoring for real issues.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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

  it('agent-support.yml is a valid issue form with unique ids, required agent and invocation, and non-empty dropdown options', () => {
    const form = parse(readTemplate('agent-support.yml')) as {
      name: string;
      title: string;
      labels: string[];
      body: Array<{
        type: string;
        id?: string;
        attributes: { options?: unknown[]; render?: string; multiple?: boolean };
        validations?: { required?: boolean };
      }>;
    };
    expect(form.name).toBe('Request support for a coding agent');
    expect(form.title).toBe('agent support: <agent name>');
    expect(form.labels).toEqual(expect.arrayContaining(['agent-support', 'enhancement']));
    const ids = form.body.map((field) => field.id);
    expect(ids).toEqual(['agent', 'invocation', 'output', 'auth', 'phases', 'limits', 'command-harness', 'notes']);
    expect(new Set(ids).size).toBe(ids.length);
    const byId = new Map(form.body.map((field) => [field.id, field]));
    expect(byId.get('agent')).toMatchObject({ type: 'input', validations: { required: true } });
    expect(byId.get('invocation')).toMatchObject({
      type: 'textarea',
      attributes: { render: 'shell' },
      validations: { required: true },
    });
    for (const field of form.body.filter((f) => f.id !== 'agent' && f.id !== 'invocation')) {
      expect(field.validations?.required ?? false).toBe(false);
    }
    expect(byId.get('phases')?.attributes).toMatchObject({
      multiple: true,
      options: ['PLAN', 'BUILD', 'CHECK', 'review', 'triage', 'all'],
    });
    for (const field of form.body.filter((f) => f.type === 'dropdown')) {
      expect(field.attributes.options?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
