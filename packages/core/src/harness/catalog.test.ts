import { describe, expect, it } from 'vitest';
import { HARNESS_CATALOG, KNOWN_HARNESS_IDS, isAgenticHarness } from './catalog.js';

describe('HARNESS_CATALOG', () => {
  it('has an id on every entry that matches its record key', () => {
    for (const [key, entry] of Object.entries(HARNESS_CATALOG)) {
      expect(entry.id).toBe(key);
    }
  });

  it('exposes KNOWN_HARNESS_IDS as the catalog keys, including the six known harnesses', () => {
    expect(KNOWN_HARNESS_IDS).toEqual(Object.keys(HARNESS_CATALOG));
    expect(KNOWN_HARNESS_IDS).toEqual(
      expect.arrayContaining([
        'claude-cli',
        'codex-cli',
        'ollama-http',
        'opencode',
        'ollama-agentic',
        'ollama-command-agent',
      ]),
    );
  });

  it('isAgenticHarness reports true for agentic harnesses and false otherwise', () => {
    expect(isAgenticHarness('claude-cli')).toBe(true);
    expect(isAgenticHarness('ollama-http')).toBe(false);
    expect(isAgenticHarness('nope')).toBe(false);
  });

  it('gives every known harness a probe with a non-empty okLabel', () => {
    for (const id of KNOWN_HARNESS_IDS) {
      const entry = HARNESS_CATALOG[id];
      expect(entry.probe).toBeDefined();
      expect(entry.probe.okLabel).toBeTruthy();
    }
  });

  it('gives claude-cli a command probe requiring claude with anthropic self-auth', () => {
    const probe = HARNESS_CATALOG['claude-cli'].probe;
    expect(probe.kind).toBe('command');
    if (probe.kind === 'command') {
      expect(probe.command).toBe('claude');
      expect(probe.selfAuth?.providers).toContain('anthropic');
    }
  });

  it('gives codex-cli a command probe with cli-carried auth', () => {
    const probe = HARNESS_CATALOG['codex-cli'].probe;
    expect(probe.kind).toBe('command');
    if (probe.kind === 'command') {
      expect(probe.command).toBe('codex');
      expect(probe.auth).toBe('cli');
    }
  });

  it('gives every ollama-family harness an ollama probe', () => {
    for (const id of ['ollama-http', 'ollama-agentic', 'ollama-command-agent']) {
      expect(HARNESS_CATALOG[id].probe.kind).toBe('ollama');
    }
  });
});
