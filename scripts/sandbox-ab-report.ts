import { computeSandboxAbReport, getFactoryPaths, readEvents, renderSandboxAbReport } from '@on-par/factory-core';
import { readCosts } from '@on-par/factory-core/internal';

interface Args {
  costs?: string;
  events?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--costs') args.costs = argv[++i];
    else if (arg === '--events') args.events = argv[++i];
    else throw new Error(`unknown flag: ${arg}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const paths = getFactoryPaths(process.cwd());
const costsFile = args.costs ?? paths.costs;
const eventsFile = args.events ?? paths.events;

const report = computeSandboxAbReport(readEvents(eventsFile), readCosts(costsFile));
console.log(renderSandboxAbReport(report));
