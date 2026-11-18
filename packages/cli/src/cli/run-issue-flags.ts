import { parseMaxSlices, parseSizeGateMode, SIZE_GATE_MODES, type SizeGateMode } from '@on-par/factory-core';
import { aliasDeprecatedSizeGateMode } from '@on-par/factory-core/internal';

import { continueFromConflict } from './continue-from.js';
import { CliExitError } from './errors.js';
import { baseBranchConflict, baseBranchOrExit, inPlaceConflict, resolveWorkspaceMode } from './ship-options.js';

function sizeGateOrExit(raw: string | undefined): SizeGateMode | undefined {
  if (raw === undefined) return undefined;
  const mode = parseSizeGateMode(aliasDeprecatedSizeGateMode(raw));
  if (mode === undefined) {
    throw new CliExitError(`factory: invalid --size-gate '${raw}' — expected one of: ${SIZE_GATE_MODES.join(', ')}`, 2);
  }
  return mode;
}

function maxSlicesOrExit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = parseMaxSlices(raw);
  if (n === undefined) {
    throw new CliExitError(`factory: invalid --max-slices '${raw}' — expected a whole number from 1 to 20`, 2);
  }
  return n;
}

export function runIssueModeOrExit(
  opts: {
    stack?: boolean;
    sizeGate?: string;
    maxSlices?: string;
    baseBranch?: string;
    pr?: boolean;
    inPlace?: boolean;
    continueFrom?: string;
    handoff?: string;
  },
  env: NodeJS.ProcessEnv,
): {
  sizeGate: SizeGateMode | undefined;
  explicitStack: boolean;
  maxSlices: number | undefined;
  baseBranch: string | undefined;
  inPlace: boolean;
} {
  const { stack, sizeGate: rawSizeGate } = opts;
  const parsedSizeGate = sizeGateOrExit(rawSizeGate);
  if (stack && parsedSizeGate !== undefined && parsedSizeGate !== 'stack') {
    throw new CliExitError('factory: --stack is --size-gate stack — drop one of them', 2);
  }
  const sizeGate = stack ? 'stack' : parsedSizeGate;
  const explicitStack = stack === true || rawSizeGate === 'stack';
  const maxSlices = maxSlicesOrExit(opts.maxSlices);
  const baseBranch = baseBranchOrExit(opts.baseBranch);
  const conflict = baseBranchConflict({ baseBranch, sizeGate });
  if (conflict) throw new CliExitError(conflict, 2);
  if (sizeGate === 'stack' && opts.pr === false) {
    throw new CliExitError('factory: --stack opens a PR per slice — drop --no-pr or drop --stack', 2);
  }
  if (opts.pr === false && sizeGate !== undefined && sizeGate !== 'off') {
    throw new CliExitError('factory: --no-pr runs with the size gate off — drop --size-gate or drop --no-pr', 2);
  }
  const inPlace = resolveWorkspaceMode(opts.inPlace, env) === 'in-place';
  if (inPlace) {
    const inPlaceMsg = inPlaceConflict({ baseBranch, sizeGate });
    if (inPlaceMsg) throw new CliExitError(inPlaceMsg, 2);
  }
  const continueMsg = continueFromConflict({ ...opts, stack: explicitStack, inPlace });
  if (continueMsg) throw new CliExitError(continueMsg, 2);
  return { sizeGate, explicitStack, maxSlices, baseBranch, inPlace };
}
