import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { z } from 'zod';
import { format, resolveConfig } from 'prettier';
import {
  checkJsonSchema,
  draftJsonSchema,
  costJsonSchema,
  daemonStatusJsonSchema,
  kpisJsonSchema,
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
  ['kpis.schema.json', kpisJsonSchema],
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
  ['check.schema.json', checkJsonSchema],
  ['draft.schema.json', draftJsonSchema],
] as const;

/** Writes every CLI JSON Schema artifact, Prettier-formatted, into outputDirectory (created if absent). */
async function writeCliJsonSchemas(outputDirectory: string): Promise<void> {
  const formatOptions = (await resolveConfig(fileURLToPath(import.meta.url))) ?? {};
  mkdirSync(outputDirectory, { recursive: true });
  for (const [filename, schema] of schemas) {
    const jsonSchema = z.toJSONSchema(schema);
    const serialized = await format(JSON.stringify(jsonSchema, null, 2), { ...formatOptions, parser: 'json' });
    writeFileSync(join(outputDirectory, filename), serialized);
  }
}

/** CLI entry: exactly one non-empty output directory argument; returns the exit code. */
export async function runGenCliJsonSchemas(argv: readonly string[], err: (text: string) => void): Promise<number> {
  const [outputArgument, ...surplusArguments] = argv;
  if (outputArgument === undefined || outputArgument.length === 0 || surplusArguments.length > 0) {
    err('usage: tsx scripts/gen-cli-json-schemas.ts <output-directory>\n');
    return 2;
  }
  await writeCliJsonSchemas(resolve(outputArgument));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runGenCliJsonSchemas(process.argv.slice(2), (text) => process.stderr.write(text));
}
