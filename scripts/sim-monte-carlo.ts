import { runMonteCarloCli } from '@on-par/factory-core/testing';

process.exitCode = await runMonteCarloCli(process.argv.slice(2));
