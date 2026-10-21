// packages/cli/src/cli/risk-policy.ts — the doctor risk-policy row and the land risk-policy lines (#3387)

import { formatRiskPolicy, loadRiskPolicy, RISK_POLICY_FILE, type RiskPolicy } from '@on-par/factory-core/internal';

import type { DoctorCheck } from './doctor.js';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function riskPolicyCheck(
  repoRoot: string,
  load: (repoRoot: string) => RiskPolicy = loadRiskPolicy,
): DoctorCheck {
  // 'Repo' matches REPO_SECTION in doctor.ts; a runtime import from doctor.ts would create a cycle.
  try {
    return { name: 'risk policy', section: 'Repo', ok: true, detail: formatRiskPolicy(load(repoRoot)).join('; ') };
  } catch (err) {
    return {
      name: 'risk policy',
      section: 'Repo',
      ok: false,
      optional: true,
      detail: `invalid ${RISK_POLICY_FILE}: ${errorMessage(err)}`,
      fix: `fix ${RISK_POLICY_FILE} (schema: packages/config/src/risk.ts) or delete it to use the packaged defaults`,
    };
  }
}

export function riskPolicyLines(
  repoRoot: string,
  load: (repoRoot: string) => RiskPolicy = loadRiskPolicy,
): { lines: string[]; rules?: RiskPolicy['rules'] } {
  try {
    const policy = load(repoRoot);
    const [summary, ...rest] = formatRiskPolicy(policy);
    return { lines: [`risk policy: ${summary}`, ...rest.map((l) => `  ${l}`)], rules: policy.rules };
  } catch (err) {
    return {
      lines: [
        `risk policy: invalid ${RISK_POLICY_FILE} (${errorMessage(err)}); the risk receipt uses the packaged defaults`,
      ],
    };
  }
}
