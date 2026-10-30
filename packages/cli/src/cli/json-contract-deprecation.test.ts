// packages/cli/src/cli/json-contract-deprecation.test.ts — deprecated fields in the published JSON schemas (#3834)

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { statusJsonSchema } from './json-contract.js';

type Prop = { deprecated?: boolean; description?: string };
type StatusSchema = { properties: { decomposedParents: Prop } };

describe('deprecated JSON contract fields', () => {
  it('marks decomposedParents deprecated in the published status schema', () => {
    const published = JSON.parse(
      readFileSync(new URL('../../schemas/status.schema.json', import.meta.url), 'utf-8'),
    ) as StatusSchema;
    const generated = JSON.parse(JSON.stringify(z.toJSONSchema(statusJsonSchema))) as StatusSchema;
    for (const schema of [published, generated]) {
      expect(schema.properties.decomposedParents.deprecated).toBe(true);
      expect(schema.properties.decomposedParents.description).toMatch(/later release removes/);
    }
  });
});
