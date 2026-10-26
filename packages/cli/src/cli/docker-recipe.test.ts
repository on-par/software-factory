import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(`../../../../deploy/docker/${name}`, import.meta.url), 'utf8');

describe('factoryd docker recipe', () => {
  const dockerfile = read('Dockerfile');
  const compose = read('compose.yaml');
  const envExample = read('.env.example');

  it('Dockerfile bakes no secret ARG or ENV and compose reads secrets only from env_file', () => {
    const decls = dockerfile.split('\n').filter((l) => /^\s*(ARG|ENV)\s/.test(l));
    expect(decls.length).toBeGreaterThan(0);
    for (const line of decls) expect(line).not.toMatch(/TOKEN|KEY|SECRET|PASSWORD/i);
    expect(compose).toMatch(/^\s*env_file:/m);
    expect(compose).not.toMatch(/GH_TOKEN|ANTHROPIC_API_KEY/);
    for (const line of envExample.split('\n').filter((l) => /^[A-Z_]+=/.test(l))) {
      if (/TOKEN|KEY/.test(line)) expect(line).toMatch(/=$/);
    }
  });

  it('compose recipe runs factoryd on host loopback with no published ports and no sandbox dependency', () => {
    expect(compose).toContain('network_mode: host');
    expect(compose).not.toMatch(/^\s*ports:/m);
    expect(compose.toLowerCase()).not.toContain('sandbox');
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*127\.0\.0\.1[\s\S]*\/capabilities/);
    expect(dockerfile).toContain('@on-par/factory-cli@${FACTORY_VERSION}');
    expect(dockerfile).not.toMatch(/factory-cli@latest/);
    expect(dockerfile).toMatch(/^USER node$/m);
  });
});
