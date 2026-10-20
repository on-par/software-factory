import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';
import { format, resolveConfig } from 'prettier';
import {
  costJsonSchema,
  daemonStatusJsonSchema,
  logsLineJsonSchema,
  queueListJsonSchema,
  queueAddJsonSchema,
  resumeJsonSchema,
  runDiffstatJsonSchema,
  runsJsonSchema,
  statusJsonSchema,
  usageJsonSchema,
  stopJsonSchema,
  unparkJsonSchema,
} from '../packages/cli/src/cli/json-contract.js';

const schemas = [
  ['status.schema.json', statusJsonSchema],
  ['logs-line.schema.json', logsLineJsonSchema],
  ['daemon-status.schema.json', daemonStatusJsonSchema],
  ['queue-list.schema.json', queueListJsonSchema],
  ['usage.schema.json', usageJsonSchema],
  ['cost.schema.json', costJsonSchema],
  ['runs.schema.json', runsJsonSchema],
  ['runs-diffstat.schema.json', runDiffstatJsonSchema],
  ['queue-add.schema.json', queueAddJsonSchema],
  ['stop.schema.json', stopJsonSchema],
  ['resume.schema.json', resumeJsonSchema],
  ['unpark.schema.json', unparkJsonSchema],
] as const;

const [outputArgument, ...surplusArguments] = process.argv.slice(2);
if (outputArgument === undefined || outputArgument.length === 0 || surplusArguments.length > 0) {
  process.stderr.write('usage: tsx scripts/gen-cli-json-schemas.ts <output-directory>\n');
  process.exitCode = 2;
} else {
  const outputDirectory = resolve(outputArgument);
  const formatOptions = (await resolveConfig(fileURLToPath(import.meta.url))) ?? {};
  mkdirSync(outputDirectory, { recursive: true });
  for (const [filename, schema] of schemas) {
    const jsonSchema = z.toJSONSchema(schema);
    const serialized = await format(JSON.stringify(jsonSchema, null, 2), { ...formatOptions, parser: 'json' });
    writeFileSync(join(outputDirectory, filename), serialized);
  }
}
