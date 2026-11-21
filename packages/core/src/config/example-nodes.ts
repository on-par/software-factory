import { DEFAULT_HTML_IGNORE } from './checkers-section.js';
import type { Node } from './example.js';
import { LandConfigSections } from './land-section.js';

export const landExampleNode: Node = {
  kind: 'object',
  key: 'land',
  doc: LandConfigSections.land.description,
  children: [
    {
      kind: 'unset',
      key: 'waitForCi',
      doc: 'false: factory land reads the PR and its checks once, merges a green and mergeable head, and otherwise returns checks_pending (exit 75) without waiting. Unset or true: wait for CI. --no-wait beats it.',
      example: 'false',
    },
  ],
};

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

export const VISUAL_PROOF_HINT =
  '{ uiPaths: ["src/ui/**"], routes: [{ route: "/items", state: "item-created", assert: "#item-1", paths: ["src/ui/items/**"], steps: [{ click: "#new" }, { fill: "#name", value: "Demo" }, { press: "Enter" }, { waitFor: "#item-1" }], record: "gif" }], command: ["<capture>"] }';

export const CHECK_TIME_BUDGET_EXAMPLE = '{ verifyMinutes: 10, reworkBuildMinutes: 10, safetyMarginMinutes: 2 }';

export const shipExampleNodes: Node[] = [
  {
    kind: 'unset',
    key: 'ciWatchMinutes',
    doc: 'Minutes SHIP waits for CI before leaving the PR as a draft (CI pending); the between-issue sweep lands it once CI passes. Overrides ci.watchMinutes. Unset: 10.',
    example: '10',
  },
  {
    kind: 'unset',
    key: 'watchCi',
    doc: 'false: SHIP opens or updates the PR and returns without watching CI; the run result says CI was not watched. factory land still waits for and requires green CI. Unlike ci.skip, which skips both the SHIP watch and the land CI gate. Unset: true.',
    example: 'false',
  },
];

export const checkersExampleNode = (doc: (...path: string[]) => string | undefined): Node => ({
  kind: 'object',
  key: 'checkers',
  doc: doc('checkers'),
  children: [
    {
      kind: 'object',
      key: 'html',
      doc: doc('checkers', 'html'),
      children: [
        {
          kind: 'unset',
          key: 'ignore',
          doc: doc('checkers', 'html', 'ignore'),
          example: `[${DEFAULT_HTML_IGNORE.map((pattern) => JSON.stringify(pattern)).join(', ')}]`,
        },
      ],
    },
  ],
});
