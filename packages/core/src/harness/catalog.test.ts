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
});
