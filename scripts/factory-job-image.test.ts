import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const dockerfile = read('../docker/factory-job/Dockerfile');
const lines = dockerfile.split('\n');
const image = (parse(read('../.github/workflows/publish.yml')) as { jobs: Record<string, Job> }).jobs.image as Job;
const buildStep = image.steps.find((s) => s.uses?.startsWith('docker/build-push-action@')) as Step;

describe('docker/factory-job/Dockerfile', () => {
  it('runs as the non-root node user with tini as PID 1', () => {
    const users = lines.filter((l) => /^USER\s/.test(l));
    expect(users.at(-1)).toBe('USER node');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
  });

  it('installs git, gh and the pinned Claude Code and factory-cli', () => {
    expect(dockerfile).toMatch(/apt-get install[^\n]*\bgit\b/);
    expect(dockerfile).toContain('releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.deb');
    expect(dockerfile).toContain('@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}');
    expect(dockerfile).toContain('@on-par/factory-cli@${FACTORY_VERSION}');
  });

  it('pins Claude Code to the factory-run.sh version', () => {
    const fromScript = /^CLAUDE_CODE_VERSION=(\S+)$/m.exec(read('./factory-run.sh'))?.[1];
    const fromDockerfile = /^ARG CLAUDE_CODE_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
    expect(fromScript).toBeDefined();
    expect(fromDockerfile).toBe(fromScript);
  });

  it('pins factory-cli to the FACTORY_VERSION build arg the publish job passes from the tag', () => {
    expect(dockerfile).toContain('test -n "$FACTORY_VERSION"');
    const args = String(buildStep.with?.['build-args']);
    expect(args).toContain('FACTORY_VERSION=${{ steps.meta.outputs.version }}');
    const derive = image.steps.find((s) => s.id === 'meta') as Step;
    expect(derive.env?.REF_NAME).toBe('${{ github.ref_name }}');
    expect(derive.run).toContain('${REF_NAME#v}');
  });

  it('installs gh from its pinned release .deb with a checked sha256, never an apt version pin', () => {
    // cli.github.com's apt repo keeps only the newest gh, so `gh=<version>` breaks on every gh release.
    expect(dockerfile).not.toMatch(/"gh=/);
    expect(dockerfile).not.toContain('cli.github.com/packages');
    expect(dockerfile).toMatch(/^ARG GH_SHA256_AMD64=[0-9a-f]{64}$/m);
    expect(dockerfile).toMatch(/^ARG GH_SHA256_ARM64=[0-9a-f]{64}$/m);
    expect(dockerfile).toContain('sha256sum -c -');
  });

  it('declares no secret ARG or ENV in the Dockerfile', () => {
    const declared = lines.filter((l) => /^(ARG|ENV)\s/.test(l));
    expect(declared.length).toBeGreaterThan(0);
    for (const l of declared) expect(l).not.toMatch(/TOKEN|KEY|SECRET|PASSWORD/i);
  });

  it('copies only the packed tarballs from the build context and checks the installed version', () => {
    expect(read('../docker/factory-job/.dockerignore').trim().split('\n')).toEqual(['*', '!pkgs/']);
    expect(lines.filter((l) => /^(COPY|ADD)\s/.test(l))).toEqual(['COPY pkgs/ /tmp/pkgs/']);
    expect(dockerfile).toContain('npm install --omit=dev --no-audit --no-fund /tmp/pkgs/*.tgz');
    expect(dockerfile).toContain('test "$(factory --version)" = "$FACTORY_VERSION"');
    // Claude Code installs before the tarballs are copied, so its layer stays cached between releases.
    const claude = lines.findIndex((l) => l.includes('@anthropic-ai/claude-code@'));
    expect(claude).toBeGreaterThan(-1);
    expect(claude).toBeLessThan(lines.indexOf('COPY pkgs/ /tmp/pkgs/'));
  });
});

describe('.github/workflows/publish.yml image job', () => {
  it('builds linux/amd64 and linux/arm64 only on a v tag after npm publish', () => {
    expect(image.needs).toBe('publish');
    expect(image.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(image.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(buildStep.with?.platforms).toBe('linux/amd64,linux/arm64');
    expect(buildStep.with).toMatchObject({ context: 'docker/factory-job', push: true, provenance: true });
  });

  it('tags the version and latest only for a non-prerelease tag and records the digest', () => {
    const tags = String(buildStep.with?.tags);
    expect(tags).toContain('ghcr.io/on-par/factory-job:${{ steps.meta.outputs.version }}');
    expect(tags).toContain("steps.meta.outputs.prerelease == 'false' && 'ghcr.io/on-par/factory-job:latest'");
    const digest = image.steps.find((s) => s.env?.DIGEST === '${{ steps.build.outputs.digest }}') as Step;
    expect(digest.run).toContain('$GITHUB_STEP_SUMMARY');
    expect(buildStep.id).toBe('build');
  });

  it('builds from the tarballs the publish job packed, never waiting on the npm registry', () => {
    const download = image.steps.find((s) => s.uses?.startsWith('actions/download-artifact@')) as Step;
    expect(download.with).toEqual({ name: 'release-tarballs', path: 'docker/factory-job/pkgs' });
    expect(image.steps.indexOf(download)).toBeLessThan(image.steps.indexOf(buildStep));
    expect(image.steps.some((s) => s.run?.includes('npm view'))).toBe(false);
    expect(buildStep.with).toMatchObject({
      'cache-from': 'type=gha,scope=factory-job',
      'cache-to': 'type=gha,scope=factory-job,mode=max',
    });
    const publish = (parse(read('../.github/workflows/publish.yml')) as { jobs: Record<string, Job> }).jobs
      .publish as Job;
    const pack = publish.steps.find((s) => s.name === 'Pack release tarballs') as Step;
    expect(pack.run).toBe('bash scripts/pack-release-tarballs.sh "$RUNNER_TEMP/pkgs"');
    const upload = publish.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@')) as Step;
    expect(upload.with?.name).toBe('release-tarballs');
    expect(publish.steps.indexOf(pack)).toBeGreaterThan(publish.steps.findIndex((s) => s.id === 'publish'));
  });

  it('skips the full Verify on a tag only when release-prior-ci.sh reports the tree already verified', () => {
    const publish = (parse(read('../.github/workflows/publish.yml')) as { jobs: Record<string, Job> }).jobs
      .publish as Job;
    const prior = publish.steps.find((s) => s.id === 'prior') as Step;
    expect(prior.run).toBe('bash scripts/release-prior-ci.sh');
    const verify = publish.steps.find((s) => s.name === 'Verify') as Step;
    expect(verify.if).toContain("steps.prior.outputs.verified != 'true'");
    const build = publish.steps.find((s) => s.name === 'Install and build') as Step;
    expect(build.if).toContain("steps.prior.outputs.verified == 'true'");
  });

  it('passes workflow values through env, never inputs inside run', () => {
    const runs = image.steps.filter((s) => s.run !== undefined);
    expect(runs.length).toBeGreaterThan(0);
    for (const step of runs) expect(step.run).not.toContain('${{');
  });

  it('pins every action by a version tag', () => {
    for (const step of image.steps.filter((s) => s.uses !== undefined)) expect(step.uses).toMatch(/@v\d+$/);
  });
});
