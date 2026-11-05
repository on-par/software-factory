import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
}
interface Job {
  needs?: string;
  if?: string;
  steps: Step[];
}

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const dockerfile = read('../docker/factory-job/Dockerfile');
const workflow = parse(read('../.github/workflows/publish.yml')) as { jobs: Record<string, Job> };
const image = workflow.jobs.image as Job;
const build = image.steps.find((step) => step.uses?.startsWith('docker/build-push-action@')) as Step;
const buildWith = build.with ?? {};

describe('docker/factory-job/Dockerfile', () => {
  it('runs as the non-root node user with tini as PID 1', () => {
    const users = dockerfile.match(/^USER .+$/gm) ?? [];
    expect(users.at(-1)).toBe('USER node');
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/usr\/bin\/tini", "--"\]$/m);
  });

  it('installs git, gh and the pinned Claude Code and factory-cli', () => {
    expect(dockerfile).toMatch(/apt-get install[^\n]*\bgit\b/);
    expect(dockerfile).toContain('"gh=${GH_VERSION}"');
    expect(dockerfile).toContain('@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}');
    expect(dockerfile).toContain('@on-par/factory-cli@${FACTORY_VERSION}');
  });

  it('pins Claude Code to the factory-run.sh version', () => {
    const fromScript = /^CLAUDE_CODE_VERSION=(\S+)$/m.exec(read('./factory-run.sh'))?.[1];
    const fromDockerfile = /^ARG CLAUDE_CODE_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
    expect(fromDockerfile).toBe(fromScript);
  });

  it('pins factory-cli to the FACTORY_VERSION build arg the publish job passes from the tag', () => {
    expect(dockerfile).toMatch(/^ARG FACTORY_VERSION$/m);
    expect(dockerfile).toContain('test -n "$FACTORY_VERSION"');
    expect(String(buildWith['build-args'])).toContain('FACTORY_VERSION=${{ steps.meta.outputs.version }}');
    expect(image.steps.some((step) => step.run?.includes('version="${TAG#v}"'))).toBe(true);
  });

  it('declares no secret ARG or ENV in the Dockerfile', () => {
    const names = [...dockerfile.matchAll(/^(?:ARG|ENV)\s+([A-Za-z0-9_]+)/gm)].map((match) => match[1]);
    expect(names).toEqual(expect.arrayContaining(['FACTORY_VERSION', 'FACTORY_HEADLESS']));
    expect(names.filter((name) => /TOKEN|KEY|SECRET|PASSWORD/i.test(name ?? ''))).toEqual([]);
  });

  it('copies nothing from the build context', () => {
    expect(read('../docker/factory-job/.dockerignore').trim()).toBe('*');
  });
});

describe('.github/workflows/publish.yml image job', () => {
  it('builds linux/amd64 and linux/arm64 only on a v tag after npm publish', () => {
    expect(image.needs).toBe('publish');
    expect(image.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(buildWith.platforms).toBe('linux/amd64,linux/arm64');
    expect(buildWith.context).toBe('docker/factory-job');
    expect(buildWith.push).toBe(true);
    expect(image.steps.some((step) => step.run?.includes('npm view "@on-par/factory-cli@$VERSION"'))).toBe(true);
  });

  it('tags the version and latest only for a non-prerelease tag and records the digest', () => {
    const tags = String(buildWith.tags);
    expect(tags).toContain('ghcr.io/on-par/factory-job:${{ steps.meta.outputs.version }}');
    expect(tags).toContain("steps.meta.outputs.prerelease == 'false' && 'ghcr.io/on-par/factory-job:latest'");
    const digest = image.steps.find((step) => step.env?.DIGEST === '${{ steps.build.outputs.digest }}');
    expect(digest?.run).toContain('$GITHUB_STEP_SUMMARY');
  });

  it('passes workflow values through env, never inputs inside run', () => {
    for (const step of image.steps) expect(step.run ?? '').not.toContain('${{');
  });

  it('pins every action by a version tag', () => {
    for (const step of image.steps) {
      if (step.uses !== undefined) expect(step.uses).toMatch(/@v\d+$/);
    }
  });
});
