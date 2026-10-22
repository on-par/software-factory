import { describe, expect, it } from 'vitest';

import {
  HARNESS_CATALOG,
  harnessCliCommand,
  isAgenticHarness,
  KNOWN_HARNESS_IDS,
  retiredHarnessNotice,
  retiredHarnessReplacement,
  usesGenericBuildRoute,
} from './catalog.js';

describe('HARNESS_CATALOG', () => {
  it('has an id on every entry that matches its record key', () => {
    for (const [key, entry] of Object.entries(HARNESS_CATALOG)) {
      expect(entry.id).toBe(key);
    }
  });

  it('exposes KNOWN_HARNESS_IDS as the catalog keys, including the known harnesses', () => {
    expect(KNOWN_HARNESS_IDS).toEqual(Object.keys(HARNESS_CATALOG));
    expect(KNOWN_HARNESS_IDS).toEqual(
      expect.arrayContaining(['claude-cli', 'codex-cli', 'ollama-http', 'opencode', 'pi', 'ollama-agentic', 'command']),
    );
  });

  it('probes pi as an agentic command harness whose CLI carries its own auth', () => {
    expect(HARNESS_CATALOG.pi.probe).toMatchObject({ kind: 'command', command: 'pi', okLabel: 'pi CLI', auth: 'cli' });
    expect(isAgenticHarness('pi')).toBe(true);
  });

  it('probes opencode as a command harness whose CLI carries its own auth', () => {
    expect(HARNESS_CATALOG.opencode.probe).toMatchObject({ kind: 'command', command: 'opencode', auth: 'cli' });
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
    for (const id of ['ollama-http', 'ollama-agentic']) {
      expect(HARNESS_CATALOG[id].probe.kind).toBe('ollama');
    }
  });
});

describe('harnessCliCommand', () => {
  it('names the CLI of command-probe harnesses', () => {
    expect(harnessCliCommand('claude-cli')).toBe('claude');
    expect(harnessCliCommand('codex-cli')).toBe('codex');
    expect(harnessCliCommand('opencode')).toBe('opencode');
    expect(harnessCliCommand('pi')).toBe('pi');
  });

  it('is undefined for ollama, unknown and missing harness ids', () => {
    expect(harnessCliCommand('ollama-http')).toBeUndefined();
    expect(harnessCliCommand('my-declared-harness')).toBeUndefined();
    expect(harnessCliCommand(undefined)).toBeUndefined();
  });
});

describe('usesGenericBuildRoute', () => {
  it('is true only for pi (#2909)', () => {
    expect(usesGenericBuildRoute('pi')).toBe(true);
    for (const id of ['claude-cli', 'ollama-agentic', 'command', '']) {
      expect(usesGenericBuildRoute(id)).toBe(false);
    }
  });
});

describe('retired harness aliases', () => {
  it('keeps ollama-command-agent out of the known harness ids', () => {
    expect(KNOWN_HARNESS_IDS).not.toContain('ollama-command-agent');
  });

  it('maps ollama-command-agent to ollama-agentic and nothing else', () => {
    expect(retiredHarnessReplacement('ollama-command-agent')).toBe('ollama-agentic');
    expect(retiredHarnessReplacement('claude-cli')).toBeUndefined();
    expect(retiredHarnessReplacement('toString')).toBeUndefined();
  });

  it('names the replacement in the notice', () => {
    const notice = retiredHarnessNotice('my-model', 'ollama-command-agent');
    expect(notice).toContain('my-model');
    expect(notice).toContain('retired');
    expect(notice).toContain('ollama-agentic');
  });
});
