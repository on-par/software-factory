import type { Node } from './example.js';

export const trackerExampleNode: Node = {
  kind: 'unset',
  key: 'tracker',
  doc: 'Ticket tracker (ADR-0168, ADR-0173). kind: github (default) or linear. linear needs teamKey; projects maps a Linear project name or id to owner/repo; readyLabel (default factory:ready), laneLabelGroup (default lane), states.ready/inProgress/parked (default Todo/In Progress/Todo). The API key is read only from LINEAR_API_KEY, never from config; `factory doctor` checks it (#3891).',
  example: '{ kind: "linear", linear: { teamKey: "ENG", projects: { "Factory": "owner/repo" } } }',
};

export const githubExampleNode: Node = {
  kind: 'unset',
  key: 'github',
  doc: 'Scoped GitHub credentials per run phase (ADR-0178). credentials.app { appId, installationId } mints a repo-scoped GitHub App installation token per phase; the private key is read only from FACTORY_GITHUB_APP_PRIVATE_KEY, never from config. Without an App, FACTORY_GITHUB_TOKEN_PLAN, _SHIP and _LAND supply fine-grained tokens. credentials.allowAmbientToken (default false) opts in to the broad ambient operator token; without any scoped credential the ambient token is still used but `factory doctor` warns and a later release fails (ADR-0160). Only land may merge.',
  example: '{ credentials: { app: { appId: 123456, installationId: 7890123 }, allowAmbientToken: false } }',
};

export const CHECK_TIME_BUDGET_EXAMPLE = '{ verifyMinutes: 10, reworkBuildMinutes: 10, safetyMarginMinutes: 2 }';
