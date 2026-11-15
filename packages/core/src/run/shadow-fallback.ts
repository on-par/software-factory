import { CLASSIFIER_PROMPT_VERSION, classifierPolicyVersion, type PrShadowVerdict } from '../review/classifier.js';
import type { ReviewClass, ReviewFloorRuleSet } from '../review/floor.js';

export function shadowErrorVerdict(
  floor: ReviewClass | null,
  rules: ReviewFloorRuleSet,
  message: string,
): PrShadowVerdict {
  return {
    modelClass: null,
    floorClass: floor,
    finalClass: floor,
    model: null,
    promptVersion: CLASSIFIER_PROMPT_VERSION,
    policyVersion: classifierPolicyVersion(rules),
    diffSha: null,
    adrIds: [],
    costUsd: null,
    claims: [],
    unsupportedClaims: [],
    notInspected: [],
    droppedClaims: 0,
    reason: `classifier error: ${message}`,
  };
}
