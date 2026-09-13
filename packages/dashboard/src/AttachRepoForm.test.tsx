// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttachRepoForm } from './AttachRepoForm.js';
import { explainAttachFailure, type AttachRepoOutcome } from './repoAttach.js';

afterEach(cleanup);

function fillForm(repo: string, path: string) {
  fireEvent.change(screen.getByLabelText('GitHub repo (owner/name)'), { target: { value: repo } });
  fireEvent.change(screen.getByLabelText('Local checkout path'), { target: { value: path } });
}

describe('AttachRepoForm', () => {
  it('scenario: operator submits slug and path (AC 1)', async () => {
    const attach = vi.fn(async (): Promise<AttachRepoOutcome> => ({ ok: true, slug: 'on-par/software-factory' }));
    render(<AttachRepoForm attach={attach} />);

    fillForm('on-par/software-factory', '/tmp/checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Attach repo' }));

    await screen.findByRole('status');
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith({ repo: 'on-par/software-factory', path: '/tmp/checkout' });
  });

  it('scenario: empty slug blocks submission and prompts for it (AC 2)', () => {
    const attach = vi.fn(async (): Promise<AttachRepoOutcome> => ({ ok: true, slug: 'x' }));
    render(<AttachRepoForm attach={attach} />);

    fillForm('', '/tmp/checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Attach repo' }));

    const slugInput = screen.getByLabelText('GitHub repo (owner/name)');
    expect(screen.getByRole('alert').textContent).toContain('Enter a GitHub repo slug');
    expect(slugInput.getAttribute('aria-invalid')).toBe('true');
    expect(slugInput.getAttribute('aria-describedby')).toBe('attach-repo-slug-error');
    expect(attach).not.toHaveBeenCalled();
  });

  it('scenario: empty checkout path blocks submission and prompts for it (AC 2)', () => {
    const attach = vi.fn(async (): Promise<AttachRepoOutcome> => ({ ok: true, slug: 'x' }));
    render(<AttachRepoForm attach={attach} />);

    fillForm('on-par/software-factory', '   ');
    fireEvent.click(screen.getByRole('button', { name: 'Attach repo' }));

    const pathInput = screen.getByLabelText('Local checkout path');
    expect(screen.getByRole('alert').textContent).toContain('Enter the absolute local checkout path');
    expect(pathInput.getAttribute('aria-invalid')).toBe('true');
    expect(pathInput.getAttribute('aria-describedby')).toBe('attach-repo-path-error');
    expect(attach).not.toHaveBeenCalled();
  });

  it('clears the field prompt and submits once the operator fills in the missing field', async () => {
    const attach = vi.fn(async (): Promise<AttachRepoOutcome> => ({ ok: true, slug: 'on-par/software-factory' }));
    render(<AttachRepoForm attach={attach} />);

    fillForm('', '/tmp/checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Attach repo' }));
    await screen.findByRole('alert');

    fillForm('on-par/software-factory', '/tmp/checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Attach repo' }));

    await screen.findByRole('status');
    const slugInput = screen.getByLabelText('GitHub repo (owner/name)');
    expect(slugInput.getAttribute('aria-invalid')).toBe('false');
    expect(slugInput.getAttribute('aria-describedby')).toBeNull();
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('scenario: missing config blocks attach', async () => {
    const explanation = explainAttachFailure('missing-factory-config', '/tmp/checkout/.factory/config.json not found');
    const attach = vi.fn(async (): Promise<AttachRepoOutcome> => ({ ok: false, explanation }));
    render(<AttachRepoForm attach={attach} />);

    fillForm('on-par/software-factory', '/tmp/checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Attach repo' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Factory config required');
    expect(alert.textContent).toContain('factory init');
    expect(alert.textContent).toContain('.factory/config.json');
    expect(screen.queryByRole('status')).toBeNull();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith({ repo: 'on-par/software-factory', path: '/tmp/checkout' });
  });

  it('scenario: origin mismatch blocks attach', async () => {
    const detail = 'origin is on-par/other-repo, not on-par/software-factory';
    const explanation = explainAttachFailure('origin-mismatch', detail);
    const attach = vi.fn(async (): Promise<AttachRepoOutcome> => ({ ok: false, explanation }));
    render(<AttachRepoForm attach={attach} />);

    fillForm('on-par/software-factory', '/tmp/checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Attach repo' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('does not match');
    expect(alert.textContent).toContain('on-par/other-repo');
    expect(alert.textContent).toContain('on-par/software-factory');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders the confirmation and no alert on the happy path', async () => {
    const attach = vi.fn(async (): Promise<AttachRepoOutcome> => ({ ok: true, slug: 'on-par/software-factory' }));
    render(<AttachRepoForm attach={attach} />);

    fillForm('on-par/software-factory', '/tmp/checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Attach repo' }));

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Attached on-par/software-factory.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('leaves the submit button enabled with blank fields so the empty-submit scenario is reachable', () => {
    const attach = vi.fn(async (): Promise<AttachRepoOutcome> => ({ ok: true, slug: 'x' }));
    render(<AttachRepoForm attach={attach} />);

    const button = screen.getByRole('button', { name: 'Attach repo' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('disables the submit button while a request is in flight and re-enables after it settles', async () => {
    let resolveAttach!: (outcome: AttachRepoOutcome) => void;
    const attach = vi.fn(
      () =>
        new Promise<AttachRepoOutcome>((resolve) => {
          resolveAttach = resolve;
        }),
    );
    render(<AttachRepoForm attach={attach} />);

    fillForm('on-par/software-factory', '/tmp/checkout');
    const button = screen.getByRole('button', { name: 'Attach repo' }) as HTMLButtonElement;
    fireEvent.click(button);

    expect(button.disabled).toBe(true);

    resolveAttach({ ok: true, slug: 'on-par/software-factory' });
    await screen.findByRole('status');
    expect(button.disabled).toBe(false);
  });

  it('scenario: a successful attach calls onAttached once with the slug (AC 1)', async () => {
    const attach = vi.fn(async (): Promise<AttachRepoOutcome> => ({ ok: true, slug: 'on-par/software-factory' }));
    const onAttached = vi.fn();
    render(<AttachRepoForm attach={attach} onAttached={onAttached} />);

    fillForm('on-par/software-factory', '/tmp/checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Attach repo' }));

    await screen.findByRole('status');
    expect(onAttached).toHaveBeenCalledTimes(1);
    expect(onAttached).toHaveBeenCalledWith('on-par/software-factory');
  });

  it('scenario: a rejected attach never calls onAttached (AC 2)', async () => {
    const explanation = explainAttachFailure('origin-mismatch', 'origin is on-par/other-repo, not on-par/x');
    const attach = vi.fn(async (): Promise<AttachRepoOutcome> => ({ ok: false, explanation }));
    const onAttached = vi.fn();
    render(<AttachRepoForm attach={attach} onAttached={onAttached} />);

    fillForm('on-par/software-factory', '/tmp/checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Attach repo' }));

    await screen.findByRole('alert');
    expect(onAttached).not.toHaveBeenCalled();
  });

  it('replaces the previous alert on a second failed submit rather than stacking two', async () => {
    const explanation = explainAttachFailure('origin-mismatch', 'origin is on-par/other-repo, not on-par/x');
    const attach = vi.fn(async (): Promise<AttachRepoOutcome> => ({ ok: false, explanation }));
    render(<AttachRepoForm attach={attach} />);

    fillForm('on-par/software-factory', '/tmp/checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Attach repo' }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Attach repo' }));
    await screen.findByRole('alert');

    expect(attach).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
