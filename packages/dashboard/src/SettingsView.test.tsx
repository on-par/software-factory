// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRepoPolicyClient,
  SettingsView,
  type RepoPolicyClient,
  type RepoPolicySnapshot,
} from './SettingsView.js';

afterEach(cleanup);

function fixtureSnapshot(overrides: Partial<RepoPolicySnapshot['fields'][number]> = {}): RepoPolicySnapshot {
  return {
    repo: 'on-par/software-factory',
    configPath: '/repos/software-factory/.factory/config.json',
    fields: [
      {
        id: 'merge.auto',
        label: 'Auto-merge',
        description: 'Squash-merge a shipped PR automatically once CI is green.',
        value: false,
        source: 'config',
        sourceDetail: 'merge.auto',
        editable: true,
        ...overrides,
      },
    ],
  };
}

function fakeClient(overrides: Partial<RepoPolicyClient> = {}): RepoPolicyClient {
  return {
    load: () => Promise.resolve(fixtureSnapshot()),
    save: () => Promise.resolve(fixtureSnapshot({ value: true })),
    ...overrides,
  };
}

const ADMIN_CONFIRM = {
  token: 'ENABLE_ADMIN_MERGE_BYPASS',
  auditText: 'admin-merge bypass explicitly enabled — required checks can be skipped when merging',
};

function adminSnapshot(overrides: Partial<RepoPolicySnapshot['fields'][number]> = {}): RepoPolicySnapshot {
  return {
    repo: 'on-par/software-factory',
    configPath: '/repos/software-factory/.factory/config.json',
    fields: [
      {
        id: 'merge.admin',
        label: 'Admin-merge (bypass required checks)',
        description: 'Merge a shipped PR using GitHub admin privileges even when required checks have not passed.',
        value: false,
        source: 'default',
        sourceDetail: 'built-in default',
        editable: true,
        confirmEnable: ADMIN_CONFIRM,
        ...overrides,
      },
    ],
  };
}

describe('SettingsView', () => {
  it('renders the field label, description, and a config source badge', async () => {
    render(<SettingsView client={fakeClient()} />);

    expect(await screen.findByText('Auto-merge')).toBeDefined();
    expect(screen.getByText('Squash-merge a shipped PR automatically once CI is green.')).toBeDefined();
    expect(screen.getByText('Source: merge.auto')).toBeDefined();
  });

  it('renders the built-in default source badge for a default-sourced field', async () => {
    const client = fakeClient({ load: () => Promise.resolve(fixtureSnapshot({ source: 'default' })) });
    render(<SettingsView client={client} />);

    expect(await screen.findByText('Source: built-in default')).toBeDefined();
  });

  it('renders a disabled checkbox and env explanation for an env-sourced field', async () => {
    const client = fakeClient({
      load: () =>
        Promise.resolve(
          fixtureSnapshot({ source: 'env', sourceDetail: 'env: FACTORY_MERGE=1', editable: false, value: true }),
        ),
    });
    render(<SettingsView client={client} />);

    await screen.findByText('Auto-merge');
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true);
    expect(screen.getByText('Source: env: FACTORY_MERGE=1')).toBeDefined();
    expect(screen.getByText('Set by an environment variable — edit it there.')).toBeDefined();
  });

  it('renders a disabled checkbox and flag explanation for a flag-sourced field', async () => {
    const client = fakeClient({
      load: () =>
        Promise.resolve(fixtureSnapshot({ source: 'flag', sourceDetail: '--merge', editable: false, value: true })),
    });
    render(<SettingsView client={client} />);

    await screen.findByText('Auto-merge');
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true);
    expect(screen.getByText('Source: CLI flag --merge')).toBeDefined();
    expect(screen.getByText('Set by a CLI flag — edit it there.')).toBeDefined();
  });

  it('clicking the checkbox calls save and re-renders the returned snapshot', async () => {
    const save = vi
      .fn()
      .mockResolvedValue(fixtureSnapshot({ value: true, source: 'config', sourceDetail: 'merge.auto' }));
    render(<SettingsView client={fakeClient({ save })} />);

    await screen.findByText('Auto-merge');
    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => expect(screen.getByRole('checkbox')).toHaveProperty('checked', true));
    expect(save).toHaveBeenCalledWith('merge.auto', true, undefined);
  });

  it('a rejecting load() renders the message in a role=alert node', async () => {
    render(<SettingsView client={fakeClient({ load: () => Promise.reject(new Error('boom')) })} />);

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'boom');
  });

  it('a rejecting load() with a non-Error value stringifies it', async () => {
    render(<SettingsView client={fakeClient({ load: () => Promise.reject('plain string rejection') })} />);

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'plain string rejection');
  });

  it('a rejecting save() renders the error and leaves the checkbox enabled', async () => {
    const client = fakeClient({ save: () => Promise.reject(new Error('save failed')) });
    render(<SettingsView client={client} />);

    await screen.findByText('Auto-merge');
    fireEvent.click(screen.getByRole('checkbox'));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'save failed');
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', false);
  });

  it('a rejecting save() with a non-Error value stringifies it', async () => {
    const client = fakeClient({ save: () => Promise.reject('plain string rejection') });
    render(<SettingsView client={client} />);

    await screen.findByText('Auto-merge');
    fireEvent.click(screen.getByRole('checkbox'));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'plain string rejection');
  });

  describe('admin-merge confirmation gate (#1390)', () => {
    it('enabling shows a distinct confirmation step instead of saving immediately', async () => {
      const save = vi.fn();
      const client: RepoPolicyClient = { load: () => Promise.resolve(adminSnapshot()), save };
      render(<SettingsView client={client} />);

      await screen.findByText('Admin-merge (bypass required checks)');
      fireEvent.click(screen.getByRole('checkbox'));

      expect(await screen.findByRole('alertdialog')).toBeDefined();
      expect(save).not.toHaveBeenCalled();
    });

    it('cancelling the confirmation never calls save', async () => {
      const save = vi.fn();
      const client: RepoPolicyClient = { load: () => Promise.resolve(adminSnapshot()), save };
      render(<SettingsView client={client} />);

      await screen.findByText('Admin-merge (bypass required checks)');
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(save).not.toHaveBeenCalled();
    });

    it('confirming calls save with the confirmation token and shows the audit text in a role=status banner', async () => {
      const save = vi.fn().mockResolvedValue(adminSnapshot({ value: true, source: 'config' }));
      const client: RepoPolicyClient = { load: () => Promise.resolve(adminSnapshot()), save };
      render(<SettingsView client={client} />);

      await screen.findByText('Admin-merge (bypass required checks)');
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(await screen.findByRole('button', { name: 'Enable bypass' }));

      await waitFor(() => expect(save).toHaveBeenCalledWith('merge.admin', true, ADMIN_CONFIRM.token));
      expect(await screen.findByRole('status')).toHaveProperty('textContent', ADMIN_CONFIRM.auditText);
    });

    it('disabling an already-enabled admin-merge saves immediately with no confirmation step', async () => {
      const save = vi.fn().mockResolvedValue(adminSnapshot({ value: false, source: 'config' }));
      const client: RepoPolicyClient = {
        load: () => Promise.resolve(adminSnapshot({ value: true, source: 'config' })),
        save,
      };
      render(<SettingsView client={client} />);

      await screen.findByText('Admin-merge (bypass required checks)');
      fireEvent.click(screen.getByRole('checkbox'));

      await waitFor(() => expect(save).toHaveBeenCalledWith('merge.admin', false, undefined));
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });
});

describe('createRepoPolicyClient', () => {
  function jsonResponse(body: unknown, ok = true, status = 200): Response {
    return { ok, status, json: () => Promise.resolve(body) } as Response;
  }

  function fakeFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
    return vi.fn<typeof fetch>();
  }

  it('picks the active repo from GET /repos, then GETs its policy', async () => {
    const fetchImpl = fakeFetch()
      .mockResolvedValueOnce(
        jsonResponse({
          repos: [
            { slug: 'owner/paused-repo', state: 'paused' },
            { slug: 'owner/active-repo', state: 'active' },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(fixtureSnapshot()));

    const client = createRepoPolicyClient(fetchImpl);
    const snapshot = await client.load();

    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/repos');
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/repos/owner/active-repo/policy');
    expect(snapshot.repo).toBe('on-par/software-factory');
  });

  it('save() PUTs to the resolved slug without re-listing repos', async () => {
    const fetchImpl = fakeFetch()
      .mockResolvedValueOnce(jsonResponse({ repos: [{ slug: 'owner/repo', state: 'active' }] }))
      .mockResolvedValueOnce(jsonResponse(fixtureSnapshot()))
      .mockResolvedValueOnce(jsonResponse(fixtureSnapshot({ value: true })));

    const client = createRepoPolicyClient(fetchImpl);
    await client.load();
    await client.save('merge.auto', true);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenNthCalledWith(3, '/repos/owner/repo/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ field: 'merge.auto', value: true }),
    });
  });

  it('throws when the repo list is empty', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(jsonResponse({ repos: [] }));
    const client = createRepoPolicyClient(fetchImpl);

    await expect(client.load()).rejects.toThrow('No repo attached — attach a repo to edit policy.');
  });

  it('throws on a non-ok response to GET /repos', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(jsonResponse({}, false, 500));
    const client = createRepoPolicyClient(fetchImpl);

    await expect(client.load()).rejects.toThrow('factoryd responded 500');
  });

  it('throws on a non-ok response to GET /repos/<slug>/policy', async () => {
    const fetchImpl = fakeFetch()
      .mockResolvedValueOnce(jsonResponse({ repos: [{ slug: 'owner/repo', state: 'active' }] }))
      .mockResolvedValueOnce(jsonResponse({}, false, 500));
    const client = createRepoPolicyClient(fetchImpl);

    await expect(client.load()).rejects.toThrow('factoryd responded 500');
  });

  it('throws on a non-ok response to PUT /repos/<slug>/policy', async () => {
    const fetchImpl = fakeFetch()
      .mockResolvedValueOnce(jsonResponse({ repos: [{ slug: 'owner/repo', state: 'active' }] }))
      .mockResolvedValueOnce(jsonResponse({}, false, 503));
    const client = createRepoPolicyClient(fetchImpl);

    await expect(client.save('merge.auto', true)).rejects.toThrow('factoryd responded 503');
  });
});
