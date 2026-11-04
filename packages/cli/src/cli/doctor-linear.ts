import { LINEAR_API_KEY_ENV, probeLinearSetup } from '@on-par/factory-core/internal';
import type { TrackerConfig } from '@on-par/factory-core/internal';

import { REPO_SECTION } from './doctor.js';
import type { DoctorCheck } from './doctor.js';

const NAME = 'Linear tracker';

/** Doctor rows for a repo whose tracker is Linear (#3891); a github tracker yields none. */
export async function linearTrackerChecks(
  tracker: TrackerConfig,
  env: NodeJS.ProcessEnv,
  probe: typeof probeLinearSetup = probeLinearSetup,
): Promise<DoctorCheck[]> {
  const linear = tracker.linear;
  if (tracker.kind !== 'linear' || linear === undefined) return [];
  const section = REPO_SECTION;
  const key = env[LINEAR_API_KEY_ENV]?.trim();
  if (!key) {
    return [
      {
        name: NAME,
        ok: false,
        detail: `${LINEAR_API_KEY_ENV} is not set`,
        fix: `create a Linear personal API key (Linear Settings → Security & access) and export ${LINEAR_API_KEY_ENV}; the key is never read from config`,
        section,
      },
    ];
  }
  const result = await probe({ apiKey: key, linear });
  switch (result.kind) {
    case 'unauthorized':
      return [
        {
          name: NAME,
          ok: false,
          detail: `Linear rejected ${LINEAR_API_KEY_ENV}`,
          fix: `create a new Linear personal API key and export it as ${LINEAR_API_KEY_ENV}`,
          section,
        },
      ];
    case 'team-missing':
      return [
        {
          name: NAME,
          ok: false,
          detail: `Linear team ${result.teamKey} not found`,
          fix: 'set tracker.linear.teamKey in .factory/config.yaml to a team key you can see in Linear',
          section,
        },
      ];
    case 'error':
      return [
        {
          name: NAME,
          ok: false,
          optional: true,
          detail: `could not reach Linear: ${result.message}`,
          fix: 'check network access to api.linear.app',
          section,
        },
      ];
    case 'ok': {
      const rows: DoctorCheck[] = [
        { name: NAME, ok: true, detail: `team ${linear.teamKey}: ${result.readyIssues} ready issue(s)`, section },
      ];
      rows.push(
        result.unmappedProjects.length > 0
          ? {
              name: 'Linear project mapping',
              ok: false,
              detail: `ready issues in project(s) with no repo mapping: ${result.unmappedProjects.join(', ')}`,
              fix: 'map each project to owner/repo under tracker.linear.projects in .factory/config.yaml',
              section,
            }
          : { name: 'Linear project mapping', ok: true, detail: 'every project with ready issues is mapped', section },
      );
      return rows;
    }
  }
}
